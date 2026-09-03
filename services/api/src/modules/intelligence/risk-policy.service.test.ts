import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { DEFAULT_RISK_THRESHOLDS, DOMAIN_WILDCARD_FIELD, RiskPolicyService } from "./risk-policy.service";

/**
 * Real integration test against a real Postgres (same convention as the rest of this session's tests) —
 * §AI-002 "risk_policies" previously had a real schema with zero readers or writers; this proves the reader
 * actually resolves exact-(domain,field) -> domain-wide -> the same global default every extractor used
 * before this existed, so an unconfigured domain/field is provably unaffected (additive, not a behavior
 * change).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("RiskPolicyService", () => {
  let db: Database;
  let service: RiskPolicyService;
  let dbAvailable = true;
  const testDomain = `test_domain_${generateId("riskPolicy")}`;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      await db.select().from(schema.riskPolicies).limit(1);
      service = new RiskPolicyService(db);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping RiskPolicyService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.riskPolicies).where(eq(schema.riskPolicies.domain, testDomain));
    }
  });

  it("falls back to the fixed global default when no policy row exists for a domain at all", async () => {
    if (!dbAvailable) return;
    const thresholds = await service.resolveThresholds("a_domain_nobody_configured");
    expect(thresholds).toEqual(DEFAULT_RISK_THRESHOLDS);
  });

  it("resolves a domain-wide policy row when one exists and no field is given", async () => {
    if (!dbAvailable) return;
    await db.insert(schema.riskPolicies).values({
      id: generateId("riskPolicy"),
      domain: testDomain,
      field: DOMAIN_WILDCARD_FIELD,
      reviewThreshold: 0.7,
      autoAcceptThreshold: 0.93,
      policyVersion: "v1",
    });
    const thresholds = await service.resolveThresholds(testDomain);
    expect(thresholds).toEqual({ reviewThreshold: 0.7, highThreshold: 0.93 });
  });

  it("prefers an exact (domain, field) policy over the domain-wide one when both exist", async () => {
    if (!dbAvailable) return;
    await db.insert(schema.riskPolicies).values({
      id: generateId("riskPolicy"),
      domain: testDomain,
      field: "specific_field",
      reviewThreshold: 0.6,
      autoAcceptThreshold: 0.8,
      policyVersion: "v1",
    });
    // Domain-wide row from the previous test still exists — the exact-field match must win.
    const exact = await service.resolveThresholds(testDomain, "specific_field");
    expect(exact).toEqual({ reviewThreshold: 0.6, highThreshold: 0.8 });
    // A different, unconfigured field on the SAME domain still falls back to the domain-wide row.
    const domainWide = await service.resolveThresholds(testDomain, "some_other_field");
    expect(domainWide).toEqual({ reviewThreshold: 0.7, highThreshold: 0.93 });
  });
});
