import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { IngestionService } from "./ingestion.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import type { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";

/**
 * §40.1 subscription entity resolution — previously nonexistent: extractSubscription created a fresh
 * recurringStreams+subscriptions row pair on EVERY email about the same subscription, with no dedup at
 * all. Real, DB-backed proof that a second email about the same service now updates the existing pair
 * instead of duplicating it, while a genuinely different service still gets its own pair.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const featureFlags = new FeatureFlagsService(db);
const riskPolicy = new RiskPolicyService(db);

const ownerUserId = generateId("user");

function makeAi(serviceLabel: string, isTrial: boolean): AnthropicExtractionService {
  return {
    isConfigured: () => true,
    extractStructured: vi.fn(async (request: { extractorName: string }) => {
      if (request.extractorName === "domain_classifier_v1") {
        return { data: { domains: ["subscription"] }, confidenceScore: 1, modelUsed: "test", inputTokens: 0, outputTokens: 0 };
      }
      return {
        data: {
          serviceLabel,
          merchantName: serviceLabel,
          cadence: "monthly",
          amountMinorUnits: 1599,
          currency: "USD",
          nextBillingDate: null,
          isTrial,
          trialEndsDate: null,
          cancellationInstructionsUrl: null,
          confidenceNotes: "test",
        },
        confidenceScore: 0.9,
        modelUsed: "test",
        inputTokens: 0,
        outputTokens: 0,
      };
    }),
  } as unknown as AnthropicExtractionService;
}

function makeService(ai: AnthropicExtractionService): IngestionService {
  const notifications = { createAndEnqueue: vi.fn(async () => undefined) };
  return new IngestionService(db, ai, notifications as never, {} as never, {} as never, featureFlags, riskPolicy);
}

async function ownerStreams() {
  return db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerUserId, displayName: "Subscription Dedup Test User" });
});

afterAll(async () => {
  const streams = await db.select({ id: schema.recurringStreams.id }).from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
  const streamIds = streams.map((s) => s.id);
  if (streamIds.length > 0) {
    await db.delete(schema.subscriptions).where(inArray(schema.subscriptions.recurringStreamId, streamIds));
    await db.delete(schema.recurringStreams).where(inArray(schema.recurringStreams.id, streamIds));
  }
  await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
});

describe("subscription entity resolution — real dedup, not duplicate-on-every-email", () => {
  it("a trial email followed by a renewal email for the same service updates ONE stream/subscription pair, not two", async () => {
    const trialAi = makeAi("Real Streaming Plus", true);
    await makeService(trialAi).ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Real Streaming Plus free trial has started",
      bodyText: "Welcome to your free trial subscription.",
      fromAddress: "billing@real-streaming-plus-not-a-known-sender.example",
    });

    const afterFirst = await ownerStreams();
    expect(afterFirst).toHaveLength(1);

    const renewalAi = makeAi("Real Streaming Plus", false);
    await makeService(renewalAi).ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Real Streaming Plus subscription renewed",
      bodyText: "Your subscription renewal was processed.",
      fromAddress: "billing@real-streaming-plus-not-a-known-sender.example",
    });

    const afterSecond = await ownerStreams();
    expect(afterSecond).toHaveLength(1); // still exactly one stream — the second email updated it, didn't duplicate it
    expect(afterSecond[0]!.id).toBe(afterFirst[0]!.id);

    const subs = await db.select().from(schema.subscriptions).where(eq(schema.subscriptions.recurringStreamId, afterSecond[0]!.id));
    expect(subs).toHaveLength(1); // one subscription row too, not two
    expect(subs[0]!.state).toBe("trial"); // upgraded candidate->trial by the first email, never downgraded by the second
  });

  it("a genuinely different service still gets its own stream/subscription pair", async () => {
    const otherAi = makeAi("A Totally Different Service", false);
    await makeService(otherAi).ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your A Totally Different Service subscription renewed",
      bodyText: "Renewal processed.",
      fromAddress: "billing@a-totally-different-service-not-known.example",
    });

    const allStreams = await db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    expect(allStreams.length).toBeGreaterThanOrEqual(2); // the earlier Real Streaming Plus stream plus this new one
  });
});
