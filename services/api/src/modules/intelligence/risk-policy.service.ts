import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

const DEFAULT_THRESHOLDS = { reviewThreshold: 0.55, highThreshold: 0.85 };
/** A row's own `field` value when it applies to the whole domain rather than one specific field —
 * `confidenceToBand` is called once per extraction with a single overall score, not per-field, so this
 * is the only `field` value real rows need until extraction itself becomes field-scored. */
const OVERALL_FIELD = "overall";

/**
 * §54.2 launch criteria #4 "critical dates/amounts never present as certain below configured domain
 * threshold" — `risk_policies` existed in the schema (domain/field/autoAcceptThreshold/reviewThreshold)
 * since early in this project but had zero real readers or writers; every domain shared one hardcoded
 * global constant regardless of what the schema's own column names promised. Same "unconfigured means
 * fall back to a safe default" degradation as feature flags/RevenueCat/ClamAV elsewhere in this codebase
 * — an admin who never configures a domain's policy gets the same behavior as before this service
 * existed, not a broken one.
 */
@Injectable()
export class RiskPolicyService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async thresholdsFor(domain: string): Promise<{ reviewThreshold: number; highThreshold: number }> {
    const [row] = await this.db
      .select({ reviewThreshold: schema.riskPolicies.reviewThreshold, autoAcceptThreshold: schema.riskPolicies.autoAcceptThreshold })
      .from(schema.riskPolicies)
      .where(eq(schema.riskPolicies.domain, domain))
      .orderBy(desc(schema.riskPolicies.createdAt))
      .limit(1);
    if (!row) return DEFAULT_THRESHOLDS;
    // The schema's own column is named `autoAcceptThreshold` (the score above which a fact needs no
    // review at all) — `confidenceToBand`'s `highThreshold` is exactly that concept under a different
    // name from when this service didn't exist yet. Kept both names rather than renaming the schema
    // column, since `risk_policies` is also the literal one named in §54.3's "state machine" review.
    return { reviewThreshold: row.reviewThreshold, highThreshold: row.autoAcceptThreshold };
  }

  async list() {
    return this.db.select().from(schema.riskPolicies).orderBy(schema.riskPolicies.domain);
  }

  /** Upserts on (domain, field) so an admin tightening/loosening a domain's threshold doesn't accumulate
   * an ever-growing history of superseded rows — same "there's one current policy per domain" model
   * `thresholdsFor` above reads back with `orderBy(desc(createdAt)).limit(1)` as a defensive tie-breaker,
   * not the primary mechanism. */
  async setThresholds(domain: string, reviewThreshold: number, autoAcceptThreshold: number, policyVersion: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.riskPolicies.id })
      .from(schema.riskPolicies)
      .where(eq(schema.riskPolicies.domain, domain))
      .limit(1);
    if (existing) {
      await this.db
        .update(schema.riskPolicies)
        .set({ reviewThreshold, autoAcceptThreshold, policyVersion, field: OVERALL_FIELD })
        .where(eq(schema.riskPolicies.id, existing.id));
    } else {
      await this.db.insert(schema.riskPolicies).values({
        id: generateId("riskPolicy"),
        domain,
        field: OVERALL_FIELD,
        reviewThreshold,
        autoAcceptThreshold,
        policyVersion,
      });
    }
  }
}
