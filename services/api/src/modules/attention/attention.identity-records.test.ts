import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * "Identity & Legal Continuity" (ID-001..005) "creates expiration obligations" using each record's own
 * user-configurable `reminderLeadDays` — added to AttentionService.scanAndFileDeadlines. Also exercises
 * TRIP-006's passport-readiness preference for a dedicated `identity_records` row over the generic
 * Documents-vault fallback once one exists for that owner.
 */
describe("AttentionService.scanAndFileDeadlines — identity-records expiration obligations", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attention-idr-${ownerUserId}@example.com`, displayName: "Attention Identity Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService identity-records tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.identityRecords).where(eq(schema.identityRecords.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("files identity_record_expiring only once the record enters ITS OWN reminderLeadDays window — a 90-day lead files at 60 days out, a 10-day lead does not", async () => {
    if (!dbAvailable) return;
    const sixtyDaysOut = new Date(Date.now() + 60 * 86_400_000);
    const longLeadId = generateId("identityRecord");
    const shortLeadId = generateId("identityRecord");
    await db.insert(schema.identityRecords).values([
      {
        id: longLeadId,
        ownerUserId,
        recordType: "drivers_license",
        label: "Long-lead license",
        expirationDate: { precision: "date", instantUtc: null, date: sixtyDaysOut.toISOString().slice(0, 10), timezone: null, sourceText: null },
        expirationDateSort: sixtyDaysOut,
        reminderLeadDays: 90, // 60 days out IS inside a 90-day lead — should file
        status: "active",
      },
      {
        id: shortLeadId,
        ownerUserId,
        recordType: "drivers_license",
        label: "Short-lead license",
        expirationDate: { precision: "date", instantUtc: null, date: sixtyDaysOut.toISOString().slice(0, 10), timezone: null, sourceText: null },
        expirationDateSort: sixtyDaysOut,
        reminderLeadDays: 10, // 60 days out is OUTSIDE a 10-day lead — should NOT file yet
        status: "active",
      },
    ]);

    await attention.scanAndFileDeadlines();

    const [longLeadItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "identity_record"), eq(schema.attentionItems.linkedResourceId, longLeadId)));
    expect(longLeadItem).toBeTruthy();
    expect(longLeadItem!.reasonCode).toBe("identity_record_expiring");
    expect(longLeadItem!.reasonText).toContain("Long-lead license");

    const [shortLeadItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "identity_record"), eq(schema.attentionItems.linkedResourceId, shortLeadId)));
    expect(shortLeadItem).toBeUndefined();
  });

  it("flips status to 'expired' and escalates the attention item once the expiration date has passed, never auto-marking a record 'renewed'", async () => {
    if (!dbAvailable) return;
    const alreadyPast = new Date(Date.now() - 2 * 86_400_000);
    const recordId = generateId("identityRecord");
    await db.insert(schema.identityRecords).values({
      id: recordId,
      ownerUserId,
      recordType: "vehicle_registration",
      label: "Overdue registration",
      expirationDate: { precision: "date", instantUtc: null, date: alreadyPast.toISOString().slice(0, 10), timezone: null, sourceText: null },
      expirationDateSort: alreadyPast,
      reminderLeadDays: 60,
      status: "active",
    });

    await attention.scanAndFileDeadlines();

    const [row] = await db.select({ status: schema.identityRecords.status }).from(schema.identityRecords).where(eq(schema.identityRecords.id, recordId));
    expect(row!.status).toBe("expired"); // never auto-flips to "renewed" — that only ever happens via the explicit renew action

    const [item] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "identity_record"), eq(schema.attentionItems.linkedResourceId, recordId)));
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe("identity_record_expired");
    expect(item!.urgency).toBe("critical");

    // Running the scan again must not file a SECOND item for the same resource (fileOrEscalate updates the
    // existing row in place rather than duplicating it).
    await attention.scanAndFileDeadlines();
    const items = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "identity_record"), eq(schema.attentionItems.linkedResourceId, recordId)));
    expect(items).toHaveLength(1);
  });

  it("TRIP-006 preference: once the owner has a dedicated passport identity_record, the travel-document-readiness scan uses it instead of the generic Documents-vault fallback", async () => {
    if (!dbAvailable) return;
    const tripStart = new Date(Date.now() + 10 * 86_400_000);
    const tripEnd = new Date(Date.now() + 17 * 86_400_000);
    const tripId = generateId("trip");
    await db.insert(schema.trips).values({
      id: tripId,
      ownerUserId,
      destinationLabel: "Identity-Recordland",
      startDate: { precision: "date", instantUtc: null, date: tripStart.toISOString().slice(0, 10), timezone: null, sourceText: null },
      startDateSort: tripStart,
      endDate: { precision: "date", instantUtc: null, date: tripEnd.toISOString().slice(0, 10), timezone: null, sourceText: null },
      endDateSort: tripEnd,
    });

    // A generic Documents-vault passport that WOULD have fired the old fallback path (expires during the trip)...
    const fallbackDocId = generateId("document");
    const duringTrip = new Date(tripEnd.getTime() - 2 * 86_400_000);
    await db.insert(schema.documents).values({
      id: fallbackDocId,
      ownerUserId,
      documentType: "identity_document",
      title: "Old-style passport doc",
      documentKind: "passport",
      expiresAt: { precision: "date", instantUtc: null, date: duringTrip.toISOString().slice(0, 10), timezone: null, sourceText: null },
      expiresAtSort: duringTrip,
      tags: [],
    });
    // ...but a dedicated identity_records passport exists for this owner, valid well beyond the trip — the
    // new preferred source should win, so NEITHER item fires (the identity_records one isn't expiring soon).
    const dedicatedPassportId = generateId("identityRecord");
    const wellAfter = new Date(tripEnd.getTime() + 400 * 86_400_000);
    await db.insert(schema.identityRecords).values({
      id: dedicatedPassportId,
      ownerUserId,
      recordType: "passport",
      label: "Dedicated passport record",
      expirationDate: { precision: "date", instantUtc: null, date: wellAfter.toISOString().slice(0, 10), timezone: null, sourceText: null },
      expirationDateSort: wellAfter,
      status: "active",
    });

    await attention.scanAndFileDeadlines();

    const [fallbackItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "document"), eq(schema.attentionItems.linkedResourceId, fallbackDocId)));
    expect(fallbackItem).toBeUndefined(); // the stale, would-have-fired Documents-vault fallback is ignored

    const [identityRecordItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "identity_record"), eq(schema.attentionItems.linkedResourceId, dedicatedPassportId)));
    expect(identityRecordItem).toBeUndefined(); // valid well beyond the trip and outside its own 60-day default lead — nothing should fire from either path

    await db.delete(schema.documents).where(eq(schema.documents.id, fallbackDocId));
    await db.delete(schema.trips).where(eq(schema.trips.id, tripId));
  });
});
