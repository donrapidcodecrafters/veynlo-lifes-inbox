import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/**
 * §AI-002 "Confidence and risk policy" — every extractor in `IngestionService` used exactly one global
 * `{ reviewThreshold: 0.55, highThreshold: 0.85 }` pair regardless of domain/field/action-impact, even
 * though `risk_policies` (packages/db/src/schema/pipeline.ts) already modeled a real per-(domain, field)
 * override. Found live: zero readers or writers of that table anywhere in the codebase — dead schema.
 *
 * This is the reader. A domain-wide override (no specific field) is stored with `field =
 * DOMAIN_WILDCARD_FIELD`; `resolveThresholds` falls back exact-(domain,field) -> domain-wide ->
 * `DEFAULT_RISK_THRESHOLDS` (the same constant every extractor already used), so a domain/field with no
 * configured policy behaves identically to today — this is purely additive. `risk_policies` is explicitly
 * versioned (`policyVersion`) so a domain can be re-tuned by inserting a new row rather than mutating
 * history; the most recently created matching row wins.
 */
export const DOMAIN_WILDCARD_FIELD = "*";

export interface RiskThresholds {
  reviewThreshold: number;
  highThreshold: number;
}

/** Identical to the global default every `confidenceToBand` call site in `IngestionService` used before
 * this service existed — the fallback when nothing more specific is configured for a domain/field. */
export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { reviewThreshold: 0.55, highThreshold: 0.85 };

@Injectable()
export class RiskPolicyService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Resolves the {reviewThreshold, highThreshold} pair `confidenceToBand` should use for a given domain
   * (e.g. "receipt", "bill") and, optionally, a specific field within it. Omitting `field` (or passing one
   * with no dedicated policy row) resolves the domain-wide policy instead.
   */
  async resolveThresholds(domain: string, field: string = DOMAIN_WILDCARD_FIELD): Promise<RiskThresholds> {
    if (field !== DOMAIN_WILDCARD_FIELD) {
      const exact = await this.lookup(domain, field);
      if (exact) return exact;
    }
    const domainLevel = await this.lookup(domain, DOMAIN_WILDCARD_FIELD);
    if (domainLevel) return domainLevel;
    return DEFAULT_RISK_THRESHOLDS;
  }

  private async lookup(domain: string, field: string): Promise<RiskThresholds | null> {
    const [row] = await this.db
      .select({ autoAcceptThreshold: schema.riskPolicies.autoAcceptThreshold, reviewThreshold: schema.riskPolicies.reviewThreshold })
      .from(schema.riskPolicies)
      .where(and(eq(schema.riskPolicies.domain, domain), eq(schema.riskPolicies.field, field)))
      .orderBy(desc(schema.riskPolicies.createdAt))
      .limit(1);
    if (!row) return null;
    // riskPolicies.autoAcceptThreshold is the score above which a fact is trusted enough to band "high"
    // (§AI-002's "auto-accept"); confidenceToBand's `highThreshold` param is exactly that same concept.
    return { reviewThreshold: row.reviewThreshold, highThreshold: row.autoAcceptThreshold };
  }
}
