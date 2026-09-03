import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * Round-3 integration audit finding: `scanAndFileDeadlines` correctly stamps `householdId` on every
 * attention item it files for a shared bill/warranty/pet-vaccination/etc., but `AttentionService.home()`
 * — the actual "Needs You" queue backing `GET /v1/home` — used to filter strictly by `ownerUserId`, so a
 * second active member of the SAME household got an empty/caught-up queue for a shared deadline they can
 * already see via that domain's own list endpoint (bills/warranties/pets all OR in household membership).
 * Confirmed live end-to-end during a full household journey: filed a real overdue bill + expiring warranty
 * + expiring pet vaccination for a shared household via the real `scanAndFileDeadlines`, and a second real
 * active member's `/v1/home` came back `caughtUp: true` — completely empty — despite the exact same data
 * being correctly visible to them on Life/Timeline. This proves the fix (OR in `activeHouseholdIds`,
 * mirroring `personalToday`'s existing precedent) against real Postgres, not just a stubbed household list.
 */
describe("AttentionService.home — household-shared visibility", () => {
  let db: Database;
  let households: HouseholdService;
  let attention: AttentionService;

  let ownerUserId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let dbAvailable = true;
  const itemIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    attention = new AttentionService(db, households, stubNotifications);

    try {
      ownerUserId = generateId("user");
      memberUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");

      await db.insert(schema.users).values([
        { id: ownerUserId, email: `attn-hh-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: memberUserId, email: `attn-hh-member-${memberUserId}@example.com`, displayName: "Member" },
        { id: outsiderUserId, email: `attn-hh-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Attention Visibility Test Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService household-visibility tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of itemIds) {
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.id, id));
    }
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
    await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
  });

  async function makeItem(filerUserId: string, hhId: string | null, reasonCode: string): Promise<string> {
    const id = generateId("attentionItem");
    const dueAtSort = new Date(Date.now() + 2 * 86_400_000);
    await db.insert(schema.attentionItems).values({
      id,
      ownerUserId: filerUserId,
      householdId: hhId,
      reasonCode,
      reasonText: reasonCode,
      urgency: "critical",
      dueAt: { precision: "date", instantUtc: null, date: dueAtSort.toISOString().slice(0, 10), timezone: null, sourceText: null },
      dueAtSort,
      moneyAtStakeMinorUnits: null,
      moneyAtStakeCurrency: null,
      confidenceBand: "verified",
      linkedResourceType: "bill",
      linkedResourceId: id,
      primaryActions: [],
    });
    itemIds.push(id);
    return id;
  }

  it("shows a household-shared item filed under the OWNER's id to a second active household member", async () => {
    if (!dbAvailable) return;
    const sharedId = await makeItem(ownerUserId, householdId, "bill_overdue");

    const ownerHome = await attention.home(ownerUserId);
    expect(ownerHome.items.map((i) => i.id)).toContain(sharedId);
    expect(ownerHome.caughtUp).toBe(false);

    const memberHome = await attention.home(memberUserId);
    expect(memberHome.items.map((i) => i.id)).toContain(sharedId);
    expect(memberHome.caughtUp).toBe(false);
  });

  it("never shows a household-shared item to a non-member outsider", async () => {
    if (!dbAvailable) return;
    const sharedId = await makeItem(ownerUserId, householdId, "warranty_expiring");
    const outsiderHome = await attention.home(outsiderUserId);
    expect(outsiderHome.items.map((i) => i.id)).not.toContain(sharedId);
    expect(outsiderHome.caughtUp).toBe(true);
  });

  it("never shows a personal (no householdId) item filed by another user, even a household member", async () => {
    if (!dbAvailable) return;
    const personalId = await makeItem(ownerUserId, null, "pet_vaccination_expiring");
    const memberHome = await attention.home(memberUserId);
    expect(memberHome.items.map((i) => i.id)).not.toContain(personalId);
    // ...but the owner still sees their own personal item.
    const ownerHome = await attention.home(ownerUserId);
    expect(ownerHome.items.map((i) => i.id)).toContain(personalId);
  });
});
