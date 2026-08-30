import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";

/**
 * worker-main.ts's connectorScanWorker eligibility query isn't importable as a unit (the file calls
 * `bootstrap()` unconditionally at module load — connecting to Redis/starting real BullMQ workers — so
 * importing it here would have real side effects, not a safe test boundary). This mirrors that exact WHERE
 * condition shape against a real seeded Postgres instead, proving the `retryNotBeforeAt` addition (a
 * captured Retry-After can push eligibility out further than the flat cooldown alone) actually behaves as
 * intended. Any future change to worker-main.ts's real query should be mirrored here too.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

const RECOVERABLE_CONNECTOR_HEALTH_STATES = ["rate_limited", "reauth_required", "provider_outage", "degraded"];
const CONNECTOR_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

async function isEligible(connectionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.connections.id })
    .from(schema.connections)
    .where(
      and(
        eq(schema.connections.id, connectionId),
        or(
          eq(schema.connections.health, "healthy"),
          and(
            inArray(schema.connections.health, RECOVERABLE_CONNECTOR_HEALTH_STATES),
            lte(schema.connections.updatedAt, new Date(Date.now() - CONNECTOR_RETRY_COOLDOWN_MS)),
            or(isNull(schema.connections.retryNotBeforeAt), lte(schema.connections.retryNotBeforeAt, new Date())),
          ),
        ),
        isNull(schema.connections.disconnectedAt),
      ),
    );
  return rows.length === 1;
}

const ownerUserId = generateId("user");
const createdConnectionIds: string[] = [];

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerUserId, displayName: "Connector Eligibility Test User" });
});

afterAll(async () => {
  await db.delete(schema.connections).where(inArray(schema.connections.id, createdConnectionIds));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
});

async function makeConnection(overrides: Partial<typeof schema.connections.$inferInsert>): Promise<string> {
  const id = generateId("connection");
  createdConnectionIds.push(id);
  await db.insert(schema.connections).values({
    id,
    ownerUserId,
    provider: "gmail",
    feasibilityClass: "direct_api",
    health: "healthy",
    updatedAt: new Date(Date.now() - CONNECTOR_RETRY_COOLDOWN_MS - 60_000), // past the flat cooldown by default
    ...overrides,
  });
  return id;
}

describe("connector-scan eligibility — retryNotBeforeAt", () => {
  it("a rate_limited connection past its flat cooldown, with no captured Retry-After, is eligible", async () => {
    const id = await makeConnection({ health: "rate_limited", retryNotBeforeAt: null });
    expect(await isEligible(id)).toBe(true);
  });

  it("a rate_limited connection with a future retryNotBeforeAt is NOT eligible, even past the flat cooldown", async () => {
    const id = await makeConnection({ health: "rate_limited", retryNotBeforeAt: new Date(Date.now() + 60 * 60 * 1000) });
    expect(await isEligible(id)).toBe(false);
  });

  it("becomes eligible once retryNotBeforeAt has passed", async () => {
    const id = await makeConnection({ health: "rate_limited", retryNotBeforeAt: new Date(Date.now() - 1000) });
    expect(await isEligible(id)).toBe(true);
  });

  it("a healthy connection is always eligible regardless of retryNotBeforeAt (the flat-cooldown branch never applies to it)", async () => {
    const id = await makeConnection({ health: "healthy", retryNotBeforeAt: new Date(Date.now() + 60 * 60 * 1000), updatedAt: new Date() });
    expect(await isEligible(id)).toBe(true);
  });

  it("a rate_limited connection still inside its flat cooldown is NOT eligible even with no retryNotBeforeAt set", async () => {
    const id = await makeConnection({ health: "rate_limited", retryNotBeforeAt: null, updatedAt: new Date() });
    expect(await isEligible(id)).toBe(false);
  });
});
