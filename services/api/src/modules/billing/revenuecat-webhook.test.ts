import { describe, expect, it, afterAll, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, and, isNull, or, gt } from "drizzle-orm";
import { RevenueCatService } from "./revenuecat.service";

/**
 * Zero coverage previously existed for RevenueCat's webhook handling — the mobile-IAP counterpart to
 * BillingService's Stripe handler, and a §54.2 launch-criteria flow in its own right (entitlement
 * grant/revoke, refund reconciliation, payment-issue notification). Unlike Stripe's HMAC signature, the
 * auth here is a plain static shared-secret header (configured in RevenueCat's own dashboard) — no
 * cryptographic construction needed to test it, just a matching env value.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

const AUTH_HEADER = "test-shared-secret-fake"; // gitleaks:allow — fake test value, not a real credential
process.env.REVENUECAT_WEBHOOK_AUTH_HEADER = AUTH_HEADER;

const notifications = { createAndEnqueue: vi.fn(async (_params: Record<string, unknown>) => undefined) };

function makeService(): RevenueCatService {
  return new RevenueCatService(db, notifications as never);
}

const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
  const id = generateId("user");
  createdUserIds.push(id);
  await db.insert(schema.users).values({ id, displayName: "RevenueCat Webhook Test User" });
  return id;
}

// Must match closeActiveRevenueCatEntitlements' own definition of "active" (effectiveTo null OR in the
// future) — grant events always set a real future effectiveTo from expiration_at_ms, so matching only
// `isNull` here would silently find nothing for any subscription past its first grant, the exact bug
// documented on that method.
async function activeRevenueCatEntitlement(userId: string) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(schema.entitlements)
    .where(
      and(
        eq(schema.entitlements.userId, userId),
        eq(schema.entitlements.source, "revenuecat"),
        or(isNull(schema.entitlements.effectiveTo), gt(schema.entitlements.effectiveTo, now)),
      ),
    );
  return row ?? null;
}

function event(overrides: Record<string, unknown>) {
  return { event: { id: generateId("billingEvent"), app_user_id: "placeholder", ...overrides } };
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, userId));
    await db.delete(schema.billingEvents).where(eq(schema.billingEvents.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
});

describe("RevenueCatService.handleWebhook — auth", () => {
  it("rejects a missing/incorrect auth header", async () => {
    const rc = makeService();
    await expect(rc.handleWebhook("wrong-secret", event({ type: "INITIAL_PURCHASE" }))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(rc.handleWebhook(undefined, event({ type: "INITIAL_PURCHASE" }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("acks a malformed payload without throwing (not worth RevenueCat retrying forever)", async () => {
    const rc = makeService();
    await expect(rc.handleWebhook(AUTH_HEADER, { not: "a valid event" })).resolves.toBeUndefined();
  });
});

describe("RevenueCatService.handleWebhook — entitlement grant", () => {
  it("grants a real entitlement with the expiration from the event", async () => {
    const rc = makeService();
    const userId = await makeUser();
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: expiresAt, store: "APP_STORE" }));

    const entitlement = await activeRevenueCatEntitlement(userId);
    expect(entitlement?.planKey).toBe("plus");
    expect(entitlement?.effectiveTo?.getTime()).toBe(expiresAt);
  });

  it("is idempotent — a replayed event does not grant a second entitlement", async () => {
    const rc = makeService();
    const userId = await makeUser();
    const payload = event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 1000, store: "APP_STORE" });

    await rc.handleWebhook(AUTH_HEADER, payload);
    await rc.handleWebhook(AUTH_HEADER, payload);

    const rows = await db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, userId));
    expect(rows.length).toBe(1);
  });

  it("two concurrent grant events for the same user never leave two active entitlements (row-locked read-modify-write)", async () => {
    const rc = makeService();
    const userId = await makeUser();

    // RevenueCat doesn't guarantee strict delivery ordering, and its own retries can overlap a fresh
    // delivery — two distinct grant events for the same user can genuinely arrive concurrently.
    await Promise.all([
      rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 60_000, store: "APP_STORE" })),
      rc.handleWebhook(AUTH_HEADER, event({ type: "RENEWAL", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 120_000, store: "APP_STORE" })),
    ]);

    const activeRows = await db
      .select()
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.userId, userId), eq(schema.entitlements.source, "revenuecat"), or(isNull(schema.entitlements.effectiveTo), gt(schema.entitlements.effectiveTo, new Date()))));
    expect(activeRows.length).toBe(1);
  });

  it("skips a grant event with no entitlement_ids matching a known plan", async () => {
    const rc = makeService();
    const userId = await makeUser();
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["not_a_real_plan"] }));
    expect(await activeRevenueCatEntitlement(userId)).toBeNull();
  });

  it("a RENEWAL closes the prior active row and opens exactly one new one, never leaving two active at once", async () => {
    const rc = makeService();
    const userId = await makeUser();
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 1000, store: "APP_STORE" }));
    const first = await activeRevenueCatEntitlement(userId);

    await rc.handleWebhook(AUTH_HEADER, event({ type: "RENEWAL", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 60_000, store: "APP_STORE" }));
    const second = await activeRevenueCatEntitlement(userId);

    expect(second?.id).not.toBe(first?.id);
    const allRows = await db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, userId));
    expect(allRows.filter((r) => r.effectiveTo === null || r.effectiveTo.getTime() > Date.now()).length).toBe(1);
  });
});

describe("RevenueCatService.handleWebhook — entitlement revocation", () => {
  it("EXPIRATION revokes access", async () => {
    const rc = makeService();
    const userId = await makeUser();
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 60_000, store: "APP_STORE" }));
    expect(await activeRevenueCatEntitlement(userId)).not.toBeNull();

    await rc.handleWebhook(AUTH_HEADER, event({ type: "EXPIRATION", app_user_id: userId }));
    expect(await activeRevenueCatEntitlement(userId)).toBeNull();
  });

  it("REFUND revokes access — the same 'got their money back, kept the feature' gap as Stripe's charge.refunded", async () => {
    const rc = makeService();
    const userId = await makeUser();
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 60_000, store: "APP_STORE" }));
    expect(await activeRevenueCatEntitlement(userId)).not.toBeNull();

    await rc.handleWebhook(AUTH_HEADER, event({ type: "REFUND", app_user_id: userId }));
    expect(await activeRevenueCatEntitlement(userId)).toBeNull();
  });

  it("CANCELLATION does NOT revoke access — access stays active until the real EXPIRATION fires at period end", async () => {
    const rc = makeService();
    const userId = await makeUser();
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 60_000, store: "APP_STORE" }));

    await rc.handleWebhook(AUTH_HEADER, event({ type: "CANCELLATION", app_user_id: userId }));
    expect(await activeRevenueCatEntitlement(userId)).not.toBeNull();
  });
});

describe("RevenueCatService.handleWebhook — payment issue", () => {
  it("notifies the user without revoking access, deduped per event", async () => {
    const rc = makeService();
    const userId = await makeUser();
    await rc.handleWebhook(AUTH_HEADER, event({ type: "INITIAL_PURCHASE", app_user_id: userId, entitlement_ids: ["plus"], expiration_at_ms: Date.now() + 60_000, store: "APP_STORE" }));
    notifications.createAndEnqueue.mockClear();

    const issueEvent = event({ type: "BILLING_ISSUE", app_user_id: userId });
    await rc.handleWebhook(AUTH_HEADER, issueEvent);

    expect(notifications.createAndEnqueue).toHaveBeenCalledTimes(1);
    expect(notifications.createAndEnqueue.mock.calls[0]![0]).toMatchObject({
      ownerUserId: userId,
      dedupeKey: `revenuecat-billing-issue:${(issueEvent.event as { id: string }).id}`,
      category: "billing",
    });
    expect(await activeRevenueCatEntitlement(userId)).not.toBeNull();
  });
});
