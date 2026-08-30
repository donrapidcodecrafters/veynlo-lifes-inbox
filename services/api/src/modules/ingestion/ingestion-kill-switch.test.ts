import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { IngestionService } from "./ingestion.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import type { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";

/**
 * §54.2 launch criterion 12 ("incident-response runbook is drilled/tested, kill-switches have real
 * effect") — the runbook documents `ai_extraction_disabled` as a real, checked kill switch (see
 * docs/INCIDENT_RESPONSE.md and the comment at ingestion.service.ts's featureFlags.isEnabled check), but
 * nothing ever exercised it end-to-end: a test proving the DOCUMENTED claim is actually true, not just
 * that the code path exists. Uses a fake AnthropicExtractionService whose extractStructured is a spy that
 * throws if called — the strongest possible assertion that AI extraction genuinely did not run, not just
 * that the return value looks like it didn't (a subtle difference: a spy that's merely unasserted could
 * still have been called and silently ignored).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const featureFlags = new FeatureFlagsService(db);
const riskPolicy = new RiskPolicyService(db);

const ownerUserId = generateId("user");

// A message engineered to be unambiguously "relevant" (matches evaluateRelevance's keyword patterns) from
// a sender NOT in the known-sender fast-path registry — so with the flag OFF, the only way this message
// can be classified at all is a real call into the AI classifier. That's what makes the "flag off" case a
// genuine control, not just a test that happens to pass because nothing would have called the AI anyway.
const RELEVANT_MESSAGE = {
  subject: "Your order confirmation #TEST-12345",
  bodyText: "Thanks for your order. Your order confirmation is attached.",
  fromAddress: "billing@a-merchant-not-in-the-known-sender-registry.example",
};

function makeSpyAi(classification: { domains: string[] } | "throw"): AnthropicExtractionService {
  return {
    isConfigured: () => true,
    extractStructured: vi.fn(async () => {
      if (classification === "throw") {
        throw new Error("extractStructured was called — the kill switch did not block AI extraction");
      }
      return { data: classification, confidenceScore: 1, modelUsed: "test", inputTokens: 0, outputTokens: 0 };
    }),
  } as unknown as AnthropicExtractionService;
}

function makeService(ai: AnthropicExtractionService): IngestionService {
  return new IngestionService(
    db,
    ai,
    {} as never, // NotificationDeliveryService — unreached: both branches below return before any notification would fire
    {} as never, // DocumentsService — unreached
    {} as never, // SearchIndexService — unreached
    featureFlags,
    riskPolicy,
  );
}

async function processingStateOf(sourceEventId: string): Promise<string | undefined> {
  const [row] = await db.select({ processingState: schema.sourceEvents.processingState }).from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId)).limit(1);
  return row?.processingState;
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerUserId, displayName: "Kill Switch Test User" });
});

afterAll(async () => {
  await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
  await db.delete(schema.featureFlags).where(inArray(schema.featureFlags.key, ["ai_extraction_disabled"]));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
});

beforeEach(async () => {
  await featureFlags.setEnabled("ai_extraction_disabled", false);
});

describe("ai_extraction_disabled kill switch — real end-to-end effect", () => {
  it("control: with the flag OFF, a relevant message from an unknown sender genuinely reaches the AI classifier", async () => {
    const ai = makeSpyAi({ domains: ["irrelevant"] });
    const service = makeService(ai);

    const { sourceEventId } = await service.ingestManualText({ ownerUserId, householdId: null, ...RELEVANT_MESSAGE });

    expect(ai.extractStructured).toHaveBeenCalledTimes(1);
    expect(await processingStateOf(sourceEventId)).toBe("filed"); // classified "irrelevant" -> filed with no further action
  });

  it("with the flag ON, the identical message is filed WITHOUT ever calling the AI classifier", async () => {
    await featureFlags.setEnabled("ai_extraction_disabled", true);
    const ai = makeSpyAi("throw"); // any call at all fails this test, not just an unexpected result
    const service = makeService(ai);

    const { sourceEventId } = await service.ingestManualText({ ownerUserId, householdId: null, ...RELEVANT_MESSAGE });

    expect(ai.extractStructured).not.toHaveBeenCalled();
    expect(await processingStateOf(sourceEventId)).toBe("filed");
  });

  it("flipping the flag back off restores real processing for a subsequent message (not a one-way switch)", async () => {
    await featureFlags.setEnabled("ai_extraction_disabled", true);
    await featureFlags.setEnabled("ai_extraction_disabled", false);
    const ai = makeSpyAi({ domains: ["irrelevant"] });
    const service = makeService(ai);

    await service.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your order confirmation #TEST-67890",
      bodyText: RELEVANT_MESSAGE.bodyText,
      fromAddress: RELEVANT_MESSAGE.fromAddress,
    });

    expect(ai.extractStructured).toHaveBeenCalledTimes(1);
  });
});
