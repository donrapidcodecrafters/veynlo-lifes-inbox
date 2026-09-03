import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { GraphService } from "./graph.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * §39.3 "Personal knowledge graph" — `entityDetail` only ever answered "what's directly attached to this
 * ONE entity" (a single hop). These tests prove `traverseFrom`'s real multi-hop walk: that a 2-hop
 * traversal genuinely reaches an entity connected only through an intermediate node (not just its direct
 * neighbors), that the hop bound is real (an entity one hop further out than requested never comes back,
 * even when a caller asks for more hops than the service's own ceiling allows), and that ownership is
 * re-checked at EVERY hop of the walk itself — not just on the root — so a `relationships` row that happens
 * to link two different owners' entities (which nothing in the schema's foreign keys forbids) can never
 * leak the other owner's node into a traversal, mirroring `search_documents`' own "never trust the edges
 * alone" posture.
 */
describe("GraphService.traverseFrom — multi-hop reasoning", () => {
  let db: Database;
  let graph: GraphService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  // A four-entity chain: root -> mid -> leaf -> beyond, each linked by a real `relationships` row, plus a
  // direct "leak" edge from root straight to another owner's entity.
  let rootId: string;
  let midId: string;
  let leafId: string;
  let beyondId: string;
  let otherOwnerEntityId: string;
  let midFactId: string;
  let sourceEventId: string;
  let evidenceId: string;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    graph = new GraphService(db);
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `graph-traverse-${ownerUserId}@example.com`, displayName: "Graph Traverse Owner" },
        { id: otherUserId, email: `graph-traverse-other-${otherUserId}@example.com`, displayName: "Graph Traverse Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping GraphService.traverseFrom tests — no reachable dev Postgres:", (err as Error).message);
      return;
    }

    rootId = generateId("entity");
    midId = generateId("entity");
    leafId = generateId("entity");
    beyondId = generateId("entity");
    otherOwnerEntityId = generateId("entity");

    await db.insert(schema.canonicalEntities).values([
      { id: rootId, type: "asset", ownerUserId, displayLabel: "Root Widget", aliases: [], lifecycleState: "active" },
      { id: midId, type: "warranty", ownerUserId, displayLabel: "Root Widget Warranty", aliases: [], lifecycleState: "active" },
      { id: leafId, type: "asset", ownerUserId, displayLabel: "Leaf Accessory", aliases: [], lifecycleState: "active" },
      { id: beyondId, type: "asset", ownerUserId, displayLabel: "Beyond Accessory", aliases: [], lifecycleState: "active" },
      { id: otherOwnerEntityId, type: "asset", ownerUserId: otherUserId, displayLabel: "Other Owner's Private Widget", aliases: [], lifecycleState: "active" },
    ]);

    await db.insert(schema.relationships).values([
      // root <- mid (mid "covers" root), mirroring extractWarranty's own real edge direction.
      { id: generateId("relationship"), fromEntityId: midId, toEntityId: rootId, type: "covers" },
      // mid -> leaf, a second hop out from root.
      { id: generateId("relationship"), fromEntityId: midId, toEntityId: leafId, type: "applies_to" },
      // leaf -> beyond, a THIRD hop out from root — used to prove the hop bound.
      { id: generateId("relationship"), fromEntityId: leafId, toEntityId: beyondId, type: "applies_to" },
      // A direct edge from root straight to another owner's entity — a data-integrity "leak" scenario
      // nothing in the schema's foreign keys actually forbids. `traverseFrom` must never surface the other
      // owner's node even though this edge physically exists.
      { id: generateId("relationship"), fromEntityId: rootId, toEntityId: otherOwnerEntityId, type: "owns" },
    ]);

    // A real fact + evidence citation on the 1-hop entity, so the traversal's fact/evidence hydration is
    // exercised too, not just entity/relationship reach.
    sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email",
      contentHash: "graph-traverse-test-hash",
      occurredAt: new Date(),
      idempotencyKey: `graph-traverse-test-${sourceEventId}`,
    });
    evidenceId = generateId("evidence");
    await db.insert(schema.evidenceRefs).values({ id: evidenceId, sourceEventId, locator: "warranty_notice", excerpt: "Root Widget Warranty — 24 months" });
    midFactId = generateId("fact");
    await db.insert(schema.facts).values({
      id: midFactId,
      subjectEntityId: midId,
      predicate: "warranty_expiration",
      valueJson: { warrantyLengthMonths: 24 },
      extractionMethod: "ai_extraction",
      extractorVersion: "test_v1",
      confidenceScore: 0.9,
      confidenceBand: "high",
      evidenceIds: [evidenceId],
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // Cascades: canonical_entities -> relationships/facts; source_events -> evidence_refs; users -> both.
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
  });

  it("reaches a 2-hop entity only reachable through an intermediate node", async () => {
    if (!dbAvailable) return;
    const result = await graph.traverseFrom(rootId, ownerUserId, 2);
    const ids = result.entities.map((e) => e.id);
    expect(ids).toContain(midId); // 1 hop
    expect(ids).toContain(leafId); // 2 hops, reachable only via mid
    expect(result.entities.find((e) => e.id === midId)?.hop).toBe(1);
    expect(result.entities.find((e) => e.id === leafId)?.hop).toBe(2);
  });

  it("carries real facts with their evidence citation for a reached entity", async () => {
    if (!dbAvailable) return;
    const result = await graph.traverseFrom(rootId, ownerUserId, 2);
    const fact = result.facts.find((f) => f.id === midFactId);
    expect(fact).toBeTruthy();
    expect(fact?.subjectEntityId).toBe(midId);
    expect(fact?.evidence).toHaveLength(1);
    expect(fact?.evidence[0]?.excerpt).toBe("Root Widget Warranty — 24 months");
  });

  it("is bounded: a 1-hop traversal never returns the 2-hop entity", async () => {
    if (!dbAvailable) return;
    const result = await graph.traverseFrom(rootId, ownerUserId, 1);
    const ids = result.entities.map((e) => e.id);
    expect(ids).toContain(midId);
    expect(ids).not.toContain(leafId);
    expect(ids).not.toContain(beyondId);
  });

  it("is bounded: a 2-hop traversal never returns an entity 3 hops out", async () => {
    if (!dbAvailable) return;
    const result = await graph.traverseFrom(rootId, ownerUserId, 2);
    expect(result.entities.map((e) => e.id)).not.toContain(beyondId);
  });

  it("clamps an oversized hop request to the service's own ceiling rather than trusting the caller", async () => {
    if (!dbAvailable) return;
    // Requesting far more hops than the chain even has — the 3-hop-out entity IS within the service's own
    // ceiling, so it's fine for this to come back, but `maxHops` reported must reflect the clamp, not the
    // huge number requested.
    const result = await graph.traverseFrom(rootId, ownerUserId, 999);
    expect(result.maxHops).toBeLessThanOrEqual(3);
    expect(result.entities.map((e) => e.id)).toContain(beyondId);
  });

  it("never leaks another owner's entity into the traversal, even across a real relationship edge", async () => {
    if (!dbAvailable) return;
    const result = await graph.traverseFrom(rootId, ownerUserId, 3);
    expect(result.entities.map((e) => e.id)).not.toContain(otherOwnerEntityId);
    expect(result.relationships.some((r) => r.fromEntityId === otherOwnerEntityId || r.toEntityId === otherOwnerEntityId)).toBe(false);
  });

  it("refuses to traverse from an entity the caller doesn't own", async () => {
    if (!dbAvailable) return;
    await expect(graph.traverseFrom(rootId, otherUserId, 2)).rejects.toThrow(ForbiddenException);
  });

  it("404s for a traversal root that doesn't exist", async () => {
    if (!dbAvailable) return;
    await expect(graph.traverseFrom(generateId("entity"), ownerUserId, 2)).rejects.toThrow(NotFoundException);
  });
});

describe("GraphService.resolveEntityForQuery", () => {
  let db: Database;
  let graph: GraphService;
  let ownerUserId: string;
  let dbAvailable = true;
  let entityId: string;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    graph = new GraphService(db);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `graph-resolve-${ownerUserId}@example.com`, displayName: "Graph Resolve Owner" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping GraphService.resolveEntityForQuery tests — no reachable dev Postgres:", (err as Error).message);
      return;
    }
    entityId = generateId("entity");
    await db.insert(schema.canonicalEntities).values({ id: entityId, type: "asset", ownerUserId, displayLabel: "Vintage Rolex Watch", aliases: [], lifecycleState: "active" });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("resolves a question naming every significant word of the entity's label", async () => {
    if (!dbAvailable) return;
    const resolved = await graph.resolveEntityForQuery(ownerUserId, "What do you know about my Vintage Rolex Watch?");
    expect(resolved?.id).toBe(entityId);
  });

  it("does not resolve when only a short/common word overlaps, not the real signal", async () => {
    if (!dbAvailable) return;
    const resolved = await graph.resolveEntityForQuery(ownerUserId, "What is my Netflix subscription cost?");
    expect(resolved).toBeNull();
  });
});
