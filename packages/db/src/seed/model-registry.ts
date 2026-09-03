import { createDbClient } from "../client";
import * as schema from "../schema";

/**
 * §39.2 "Model routing, versioning and evaluation" — real, honestly-sourced reference data for the two
 * models `AnthropicExtractionService.resolveModelForTier` actually routes to today (see that method's own
 * doc comment, and MODEL_BY_TIER's history in services/api/src/modules/intelligence/anthropic-extraction.
 * service.ts). Same discipline as `reference-data.ts`/`merchant-cancellation-steps.ts`: idempotent (fixed
 * ids, onConflictDoNothing), safe to re-run against any environment (dev/staging/production).
 *
 * `resolveModelForTier` falls back to a hardcoded default when this table has no active row for a tier, so
 * running this seed is not strictly required for the app to function — but without it, "retire/replace a
 * model as a data change" has nothing to act on yet. Retiring `claude-haiku-4-5-20251001` or
 * `claude-sonnet-5` going forward means inserting a new row for that tier (or setting `sunsetAt` on this
 * one) rather than editing this file and redeploying.
 *
 * Pricing is deliberately NOT included here — see modelRegistry's own schema doc comment for why
 * `MODEL_PRICING_USD_PER_MILLION_TOKENS` (anthropic-extraction.service.ts) stays the one source of truth
 * for cost, keyed by the same `modelKey` these rows use.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db = createDbClient(connectionString);

  await db
    .insert(schema.modelRegistry)
    .values([
      {
        id: "mreg_seed_claude_haiku_4_5",
        provider: "anthropic",
        modelKey: "claude-haiku-4-5-20251001",
        tier: "cheap",
        displayName: "Claude Haiku 4.5",
        // The two pipeline stages that actually pass model: "cheap" (or omit `model`, which defaults to
        // "cheap") today — see IngestionService's extractReceipt/extractBill/extractSubscription/
        // extractCalendarEvent/extractWarranty/etc. and the domain classifier, all of which use this tier
        // (§41.4 "larger reasoning models are not the default receipt parser").
        supportedTasks: ["domain_classification", "structured_extraction"],
        maxContextTokens: 200_000,
        structuredOutputReliability: "high",
        latencyClass: "fast",
        costClass: "low",
        regions: ["us"],
        privacyRetentionNote: "Anthropic first-party API — not used to train models; standard API data-retention terms apply (see Anthropic's commercial terms).",
        launchStatus: "ga",
      },
      {
        id: "mreg_seed_claude_sonnet_5",
        provider: "anthropic",
        modelKey: "claude-sonnet-5",
        tier: "reasoning",
        displayName: "Claude Sonnet 5",
        // The only two real call sites that pass model: "reasoning" today: search.service.ts's Ask
        // synthesis and automation.service.ts's agent-plan proposal generation.
        supportedTasks: ["ask_synthesis", "agent_planning", "structured_extraction"],
        maxContextTokens: 200_000,
        structuredOutputReliability: "high",
        latencyClass: "standard",
        costClass: "medium",
        regions: ["us"],
        privacyRetentionNote: "Anthropic first-party API — not used to train models; standard API data-retention terms apply (see Anthropic's commercial terms).",
        launchStatus: "ga",
      },
    ])
    .onConflictDoNothing();

  console.log("model_registry seeded (or already present).");
  process.exit(0);
}

main().catch((err) => {
  console.error("model_registry seed failed:", err);
  process.exit(1);
});
