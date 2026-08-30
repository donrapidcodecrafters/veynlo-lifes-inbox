import { describe, expect, it, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { RiskPolicyService } from "./risk-policy.service";

/** §54.2 launch criteria #4 "critical dates/amounts never present as certain below configured domain
 * threshold" — real test against local Postgres proving the per-domain configuration this service exists
 * to provide actually reads back what an admin configured, and falls back safely when nothing was. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const db: Database = createDbClient(DATABASE_URL);
const riskPolicy = new RiskPolicyService(db);
const TEST_DOMAIN = "test_domain_never_a_real_one";

afterEach(async () => {
  await db.delete(schema.riskPolicies).where(eq(schema.riskPolicies.domain, TEST_DOMAIN));
});

describe("RiskPolicyService", () => {
  it("falls back to the safe default thresholds for a domain with no configured policy", async () => {
    const thresholds = await riskPolicy.thresholdsFor(TEST_DOMAIN);
    expect(thresholds).toEqual({ reviewThreshold: 0.55, highThreshold: 0.85 });
  });

  it("returns the configured thresholds once an admin sets them", async () => {
    await riskPolicy.setThresholds(TEST_DOMAIN, 0.7, 0.95, "v1");
    const thresholds = await riskPolicy.thresholdsFor(TEST_DOMAIN);
    expect(thresholds).toEqual({ reviewThreshold: 0.7, highThreshold: 0.95 });
  });

  it("setThresholds upserts — a second call updates rather than accumulates a second row", async () => {
    await riskPolicy.setThresholds(TEST_DOMAIN, 0.6, 0.9, "v1");
    await riskPolicy.setThresholds(TEST_DOMAIN, 0.75, 0.99, "v2");
    const rows = await db.select().from(schema.riskPolicies).where(eq(schema.riskPolicies.domain, TEST_DOMAIN));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reviewThreshold).toBe(0.75);
    expect(rows[0]?.autoAcceptThreshold).toBe(0.99);
    expect(rows[0]?.policyVersion).toBe("v2");
  });

  it("does not affect thresholds for a different domain", async () => {
    await riskPolicy.setThresholds(TEST_DOMAIN, 0.7, 0.95, "v1");
    const otherDomain = await riskPolicy.thresholdsFor("bill");
    expect(otherDomain).toEqual({ reviewThreshold: 0.55, highThreshold: 0.85 });
  });
});
