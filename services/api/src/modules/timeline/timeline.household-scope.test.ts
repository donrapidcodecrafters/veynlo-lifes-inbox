import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { TimelineService } from "./timeline.service";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

/**
 * §TIME-001 "Household-shared timeline is assembled per viewer authorization" — bug found live during a
 * Family/Household requirements re-audit: `TimelineService.getTimeline` scoped every one of its six UNION
 * branches (calendar_events, purchases, bills, return_cases, documents, warranties) by `owner_user_id`
 * alone, the exact "forgot to OR in household visibility" bug class already found and fixed this session
 * in Commerce/Schedule/Lists/Assets/Documents — except nobody had fixed it here, since Timeline has no
 * `ownerOrDelegatedHousehold`-shaped helper of its own to have inherited the fix by copy-paste. Unlike the
 * other sharing tests in this session, this uses a REAL HouseholdService against real dev Postgres — the
 * exact bug class this is most at risk of reintroducing only shows up when household membership is real
 * and mutated mid-test (a member leaving).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;

describe("TimelineService — household-shared visibility", () => {
  let db: Database;
  let households: HouseholdService;
  let timeline: TimelineService;

  let ownerA: string;
  let memberC: string;
  let memberD: string; // leaves mid-test
  let strangerB: string;
  let householdId: string;
  let dbAvailable = true;

  const eventId = generateId("calendarEvent");
  const privateEventId = generateId("calendarEvent");
  const purchaseId = generateId("purchase");
  const billId = generateId("bill");
  const returnCaseId = generateId("returnCase");
  const warrantyId = generateId("warranty");
  const documentId = generateId("document");
  const insuranceDocumentId = generateId("document");

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    timeline = new TimelineService(db, households, new SharingService(db));

    try {
      ownerA = generateId("user");
      memberC = generateId("user");
      memberD = generateId("user");
      strangerB = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerA, email: `tl-owner-${ownerA}@example.com`, displayName: "Owner A" },
        { id: memberC, email: `tl-memberc-${memberC}@example.com`, displayName: "Member C" },
        { id: memberD, email: `tl-memberd-${memberD}@example.com`, displayName: "Member D" },
        { id: strangerB, email: `tl-stranger-${strangerB}@example.com`, displayName: "Stranger B" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Timeline Audit Household", billingOwnerUserId: ownerA });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerA, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberC, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberD, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);

      const now = new Date();
      const dateOnly = { precision: "date" as const, instantUtc: null, date: now.toISOString().slice(0, 10), timezone: null, sourceText: null };

      await db.insert(schema.calendarEvents).values([
        {
          id: eventId,
          ownerUserId: ownerA,
          householdId,
          title: "Household-shared dentist visit",
          start: dateOnly,
          startSort: now,
          isAllDay: true,
          source: "manual",
          visibility: "household",
        },
        {
          id: privateEventId,
          ownerUserId: ownerA,
          householdId,
          title: "Owner A's private therapy session",
          start: dateOnly,
          startSort: now,
          isAllDay: true,
          source: "manual",
          visibility: "private", // must never show up on a household member's timeline
        },
      ]);

      await db.insert(schema.purchases).values({
        id: purchaseId,
        ownerUserId: ownerA,
        householdId,
        orderNumber: "TL-AUDIT-001",
        purchaseDate: dateOnly,
        purchaseDateSort: now,
        totalMinorUnits: 1000,
        totalCurrency: "USD",
        state: "candidate",
        confidenceBand: "high",
      });

      await db.insert(schema.bills).values({
        id: billId,
        ownerUserId: ownerA,
        householdId,
        billerLabel: "Shared Electric Co",
        dueDate: dateOnly,
        dueDateSort: now,
      });

      await db.insert(schema.returnCases).values({
        id: returnCaseId,
        purchaseId,
        deadline: dateOnly,
        deadlineSort: now,
      });

      await db.insert(schema.warranties).values({
        id: warrantyId,
        ownerUserId: ownerA,
        householdId,
        productLabel: "Shared Dishwasher",
        expirationDate: dateOnly,
        expirationDateSort: now,
      });

      await db.insert(schema.documents).values([
        {
          id: documentId,
          ownerUserId: ownerA,
          householdId,
          documentType: "manual",
          title: "Shared lease agreement",
          visibility: "household",
          tags: [],
        },
        {
          id: insuranceDocumentId,
          ownerUserId: ownerA,
          householdId,
          documentType: "insurance_card", // HLTH-002 — must stay private even with visibility "household"
          title: "Owner A's insurance card",
          visibility: "household",
          tags: [],
        },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping TimelineService household-scope tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.documents).where(eq(schema.documents.householdId, householdId));
      await db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId));
      await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
      await db.delete(schema.bills).where(eq(schema.bills.id, billId));
      await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.householdId, householdId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerA));
      await db.delete(schema.users).where(eq(schema.users.id, memberC));
      await db.delete(schema.users).where(eq(schema.users.id, memberD));
      await db.delete(schema.users).where(eq(schema.users.id, strangerB));
    }
  });

  it("a stranger sees none of the household's items", async () => {
    if (!dbAvailable) return;
    const { items } = await timeline.getTimeline(strangerB, null);
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain(eventId);
    expect(ids).not.toContain(purchaseId);
    expect(ids).not.toContain(billId);
    expect(ids).not.toContain(returnCaseId);
    expect(ids).not.toContain(warrantyId);
    expect(ids).not.toContain(documentId);
  });

  it("a plain active household member (no delegation, no grant) sees every domain's household-shared item", async () => {
    if (!dbAvailable) return;
    const { items } = await timeline.getTimeline(memberC, null);
    const ids = items.map((i) => i.id);
    expect(ids).toContain(eventId);
    expect(ids).toContain(purchaseId);
    expect(ids).toContain(billId);
    expect(ids).toContain(returnCaseId);
    expect(ids).toContain(warrantyId);
    expect(ids).toContain(documentId);
  });

  it("a private-visibility calendar event never appears on another household member's timeline", async () => {
    if (!dbAvailable) return;
    const { items } = await timeline.getTimeline(memberC, null);
    expect(items.map((i) => i.id)).not.toContain(privateEventId);
    // ...but the owner still sees their own private event on their own timeline.
    const ownerTimeline = await timeline.getTimeline(ownerA, null);
    expect(ownerTimeline.items.map((i) => i.id)).toContain(privateEventId);
  });

  it("HLTH-002: an insurance_card/eob document never appears on a household member's timeline, even with visibility 'household'", async () => {
    if (!dbAvailable) return;
    const { items } = await timeline.getTimeline(memberC, null);
    expect(items.map((i) => i.id)).not.toContain(insuranceDocumentId);
    // The owner still sees their own insurance document.
    const ownerTimeline = await timeline.getTimeline(ownerA, null);
    expect(ownerTimeline.items.map((i) => i.id)).toContain(insuranceDocumentId);
  });

  it("a member who leaves the household immediately loses timeline visibility into its shared items", async () => {
    if (!dbAvailable) return;
    const before = await timeline.getTimeline(memberD, null);
    expect(before.items.map((i) => i.id)).toContain(purchaseId);

    await households.leave(householdId, memberD);

    const after = await timeline.getTimeline(memberD, null);
    const afterIds = after.items.map((i) => i.id);
    expect(afterIds).not.toContain(eventId);
    expect(afterIds).not.toContain(purchaseId);
    expect(afterIds).not.toContain(billId);
    expect(afterIds).not.toContain(returnCaseId);
    expect(afterIds).not.toContain(warrantyId);
    expect(afterIds).not.toContain(documentId);
  });
});
