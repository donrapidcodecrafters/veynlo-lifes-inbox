import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SearchService } from "./search.service";
import { GraphService } from "../graph/graph.service";
import { MemoriesService } from "../memories/memories.service";
import { SharingService } from "../sharing/sharing.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { DocumentsService } from "../documents/documents.service";
import type { HouseholdService } from "../household/household.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubEntitlements = { assertAskQuota: async () => {} } as unknown as EntitlementsService;
const stubDocuments = {} as unknown as DocumentsService;
const stubHouseholds = {} as unknown as HouseholdService;
const stubQueue = { enqueueMemoryClassification: async () => {} } as unknown as QueueProducer;
const stubPreferences = { getAskResponseStyle: async () => "balanced" as const } as unknown as PreferencesService;

/**
 * §39.3 "Personal knowledge graph" — proves `ask()`'s new graph-augmentation wiring end to end: a question
 * that names a real `canonicalEntities` row gets ADDITIONAL grounding context pulled in via
 * `GraphService.traverseFrom` (a fact that lives ONLY on a graph-connected entity two hops away from
 * anything lexically matched, not duplicated anywhere in purchases/bills/documents/etc.), while a question
 * that doesn't name a known entity gets exactly the same context it always did — no graph items at all. The
 * citation returned for a graph-derived fact carries the identical `{resourceType, resourceId, text}` shape
 * every other domain's evidence does (§28.15/ASK-001 grounding discipline), not a bare unsourced claim.
 */
describe("SearchService.ask — §39.3 graph-connected grounding", () => {
  let db: Database;
  let graph: GraphService;
  let ownerUserId: string;
  let watchEntityId: string;
  let appraiserEntityId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    graph = new GraphService(db);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `ask-graph-${ownerUserId}@example.com`, displayName: "Ask Graph Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping Ask graph-grounding tests — no reachable dev Postgres:", (err as Error).message);
      return;
    }

    // A canonical entity that ISN'T backed by any purchases/documents/etc row at all — the only way `ask()`
    // could ever know about it is via the knowledge graph itself.
    watchEntityId = generateId("entity");
    appraiserEntityId = generateId("entity");
    await db.insert(schema.canonicalEntities).values([
      { id: watchEntityId, type: "asset", ownerUserId, displayLabel: "Vintage Rolex Watch", aliases: [], lifecycleState: "active" },
      { id: appraiserEntityId, type: "organization", ownerUserId, displayLabel: "Heritage Estate Appraisers", aliases: [], lifecycleState: "active" },
    ]);
    await db.insert(schema.relationships).values({ id: generateId("relationship"), fromEntityId: appraiserEntityId, toEntityId: watchEntityId, type: "appraised" });

    const sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email",
      contentHash: "ask-graph-test-hash",
      occurredAt: new Date(),
      idempotencyKey: `ask-graph-test-${sourceEventId}`,
    });
    const evidenceId = generateId("evidence");
    await db.insert(schema.evidenceRefs).values({
      id: evidenceId,
      sourceEventId,
      locator: "appraisal_letter",
      excerpt: "Heritage Estate Appraisers valued the Vintage Rolex Watch at $12,000 in June 2026.",
    });
    await db.insert(schema.facts).values({
      id: generateId("fact"),
      subjectEntityId: appraiserEntityId,
      predicate: "appraisal_value",
      valueJson: { amount: "$12,000", currency: "USD" },
      extractionMethod: "ai_extraction",
      extractorVersion: "test_v1",
      confidenceScore: 0.9,
      confidenceBand: "high",
      evidenceIds: [evidenceId],
    });

    // A real subscription row so the "unrelated question" case still has ordinary, non-graph context to
    // work with — proving graph augmentation is additive, not a replacement for the existing path.
    const streamId = generateId("recurringStream");
    const subscriptionId = generateId("subscription");
    await db.insert(schema.recurringStreams).values({ id: streamId, ownerUserId, serviceLabel: "Netflix Premium", cadence: "monthly" });
    await db.insert(schema.subscriptions).values({ id: subscriptionId, recurringStreamId: streamId, state: "active" });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  function buildSearch(ai: FakeModelProvider): SearchService {
    const sharing = new SharingService(db);
    const memories = new MemoriesService(db, ai, stubQueue, stubDocuments, stubHouseholds, sharing);
    return new SearchService(db, ai, stubEntitlements, memories, stubPreferences, graph);
  }

  it("pulls graph-connected context (with real citation) into grounding when the question names a known entity", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const search = buildSearch(ai);
    ai.enqueue("ask_synthesis_v1", fakeExtraction({ answer: "It was appraised at $12,000.", evidenceResourceIds: [appraiserEntityId], insufficientEvidence: false }));

    const result = await search.ask(ownerUserId, "What do you know about my Vintage Rolex Watch appraisal?");

    const request = ai.requests.find((r) => r.extractorName === "ask_synthesis_v1");
    expect(request).toBeTruthy();
    const userContent = request!.userContent as string;
    // The graph-only fact (nowhere in purchases/bills/documents) genuinely reached the model's context.
    expect(userContent).toContain('type="graph_entity"');
    expect(userContent).toContain(appraiserEntityId);
    expect(userContent).toContain("$12,000");
    expect(userContent).toContain("Heritage Estate Appraisers valued the Vintage Rolex Watch at $12,000");

    // The citation the model named comes back with the SAME evidence shape every other domain uses.
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ resourceType: "graph_entity", resourceId: appraiserEntityId });
    expect(result.evidence[0]!.text).toContain("$12,000");
    expect(result.insufficientEvidence).toBe(false);
  });

  it("never adds graph context for a question that doesn't resolve to a known entity", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const search = buildSearch(ai);
    ai.enqueue("ask_synthesis_v1", fakeExtraction({ answer: "Netflix Premium, monthly.", evidenceResourceIds: [], insufficientEvidence: false }));

    await search.ask(ownerUserId, "What is my Netflix subscription cost?");

    const request = ai.requests.find((r) => r.extractorName === "ask_synthesis_v1");
    expect(request).toBeTruthy();
    const userContent = request!.userContent as string;
    expect(userContent).not.toContain('type="graph_entity"');
    expect(userContent).not.toContain(appraiserEntityId);
    expect(userContent).not.toContain(watchEntityId);
    // The ordinary lexical path still works unaffected.
    expect(userContent).toContain("Netflix Premium");
  });
});
