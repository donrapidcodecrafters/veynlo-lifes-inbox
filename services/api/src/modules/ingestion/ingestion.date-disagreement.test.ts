import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { InboxService } from "../attention/inbox.service";
import { ConflictService } from "../schedule/conflict.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { HouseholdService } from "../household/household.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";

/**
 * CAL-003 "email-vs-calendar date disagreement" — real integration test against a real Postgres. Covers the
 * buildable, precision-first slice: a HIGH-CONFIDENCE email extraction whose title tightly (exact,
 * normalized) matches an EXISTING, DIFFERENT-source calendar event (a provider sync — `providerEventId` set,
 * same distinguishing signal CAL-001's own cross-source matching uses) whose date disagrees. Verifies the
 * conflict + inbox item get filed (never auto-updated, never silently dropped), that a second email about
 * the same still-unresolved disagreement doesn't spam a duplicate item, and both resolve actions
 * (InboxService.resolveDateDisagreement) work end to end.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;
const stubHouseholds = { activeHouseholdIds: async () => [] } as unknown as HouseholdService;
const stubCalendarWriteBack = { pushEvent: async () => ({ pushed: false }) } as unknown as CalendarWriteBackService;

describe("IngestionService email-vs-calendar date disagreement", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;
  const insertedEventIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `date-disagreement-test-${ownerUserId}@example.com`, displayName: "Date Disagreement Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService date-disagreement tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    if (insertedEventIds.length > 0) {
      const allConflicts = await db.select({ id: schema.scheduleConflicts.id, involvedEventIds: schema.scheduleConflicts.involvedEventIds }).from(schema.scheduleConflicts);
      const ownConflictIds = allConflicts.filter((c) => c.involvedEventIds.some((id) => insertedEventIds.includes(id))).map((c) => c.id);
      for (const id of ownConflictIds) await db.delete(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, id));
    }
    await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function insertProviderSyncedEvent(title: string, dateIso: string) {
    const id = generateId("calendarEvent");
    insertedEventIds.push(id);
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId,
      title,
      start: { precision: "date", instantUtc: null, date: dateIso, timezone: null, sourceText: null },
      startSort: new Date(`${dateIso}T00:00:00Z`),
      isAllDay: true,
      source: "discovered_from_evidence", // ingestFeedCalendarEvent's real literal source value — see its own doc comment
      providerEventId: `provider-uid-${id}`, // the actual cross-kind signal (source alone can't distinguish)
      status: "confirmed",
      visibility: "private",
    });
    return id;
  }

  it("files a conflict + inbox item when a high-confidence email states a different date than an existing provider-synced event under the same title", async () => {
    if (!dbAvailable) return;
    const title = "Sarah's Dentist Appointment";
    const calendarEventId = await insertProviderSyncedEvent(title, "2026-11-10");

    const ai = new FakeModelProvider();
    const conflicts = new ConflictService(db, stubHouseholds);
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, conflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction(
        { title, startDate: { iso_date: "2026-11-17", approximate_text: null }, startTime: null, timezone: null, location: null, isAllDay: true, confidenceNotes: "clear" },
        0.9, // high confidence — required for this check to run at all
      ),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: title, bodyText: `${title} moved to November 17.` });

    const emailEvents = await db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.ownerUserId, ownerUserId), eq(schema.calendarEvents.source, "discovered_from_evidence")));
    const emailEvent = emailEvents.find((e) => e.id !== calendarEventId);
    expect(emailEvent).toBeDefined();
    insertedEventIds.push(emailEvent!.id);
    expect(emailEvent!.start.date).toBe("2026-11-17");
    expect(emailEvent!.providerEventId).toBeNull(); // a genuinely new email-discovered row, not linked/merged

    const conflictRows = await db
      .select()
      .from(schema.scheduleConflicts)
      .where(eq(schema.scheduleConflicts.kind, "email_calendar_date_disagreement"));
    const conflictRow = conflictRows.find((c) => c.involvedEventIds.includes(emailEvent!.id));
    expect(conflictRow).toBeDefined();

    // The Life page's plain dismiss-only conflict banner must NOT surface this kind — its correct
    // resolution is a real choice (use_email_date vs. keep_calendar_date), which only the inbox item above
    // offers; a generic "Dismiss" here would silently settle it without ever applying either date.
    const bannerConflicts = await conflicts.unresolvedConflicts(ownerUserId);
    expect(bannerConflicts.some((c) => c.id === conflictRow!.id)).toBe(false);
    // Directional, never sorted — [0] is the email side, [1] the pre-existing calendar side.
    expect(conflictRow!.involvedEventIds).toEqual([emailEvent!.id, calendarEventId]);
    expect(conflictRow!.resolvedAt).toBeNull();

    const inboxRows = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.linkedResourceType, "schedule_conflict")));
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]!.linkedResourceId).toBe(conflictRow!.id);
    expect(inboxRows[0]!.suggestedActions).toEqual(["use_email_date", "keep_calendar_date", "dismiss"]);

    // A second email about the same still-unresolved disagreement (e.g. a reminder) must not spam a
    // duplicate conflict or a duplicate inbox item.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction(
        { title, startDate: { iso_date: "2026-11-17", approximate_text: null }, startTime: null, timezone: null, location: null, isAllDay: true, confidenceNotes: "clear" },
        0.9,
      ),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: title, bodyText: `Reminder: ${title} on November 17.` });

    const conflictRowsAfter = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.kind, "email_calendar_date_disagreement"));
    expect(conflictRowsAfter.filter((c) => c.involvedEventIds.includes(emailEvent!.id))).toHaveLength(1); // still just the one row
    const inboxRowsAfter = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.linkedResourceType, "schedule_conflict")));
    expect(inboxRowsAfter).toHaveLength(1); // no second date-disagreement item filed
  });

  it("resolveDateDisagreement('use_email_date') updates the calendar-side event and resolves the conflict", async () => {
    if (!dbAvailable) return;
    const title = "Vet Checkup for Max";
    const calendarEventId = await insertProviderSyncedEvent(title, "2026-12-01");

    const ai = new FakeModelProvider();
    const conflicts = new ConflictService(db, stubHouseholds);
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, conflicts, stubTrips, stubPreferences);
    const inbox = new InboxService(db, stubCalendarWriteBack, conflicts);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({ title, startDate: { iso_date: "2026-12-08", approximate_text: null }, startTime: null, timezone: null, location: null, isAllDay: true, confidenceNotes: "clear" }, 0.9),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: title, bodyText: `${title} is now on December 8.` });

    const [inboxItem] = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.linkedResourceType, "schedule_conflict")))
      .orderBy(desc(schema.inboxItems.createdAt));
    expect(inboxItem).toBeDefined();
    const [conflictRow] = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, inboxItem!.linkedResourceId!));
    const emailEventId = conflictRow!.involvedEventIds[0]!;
    insertedEventIds.push(emailEventId);

    await inbox.resolveDateDisagreement(inboxItem!.id, ownerUserId, "use_email_date");

    const [updatedCalendarEvent] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, calendarEventId));
    expect(updatedCalendarEvent!.start.date).toBe("2026-12-08"); // the calendar side now matches the email's date

    const [resolvedConflict] = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, conflictRow!.id));
    expect(resolvedConflict!.resolvedAt).not.toBeNull();

    const [confirmedItem] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, inboxItem!.id));
    expect(confirmedItem!.reviewState).toBe("confirmed");
  });

  it("resolveDateDisagreement('keep_calendar_date') leaves both events untouched but resolves the conflict", async () => {
    if (!dbAvailable) return;
    const title = "Piano Recital";
    const calendarEventId = await insertProviderSyncedEvent(title, "2027-01-10");

    const ai = new FakeModelProvider();
    const conflicts = new ConflictService(db, stubHouseholds);
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, conflicts, stubTrips, stubPreferences);
    const inbox = new InboxService(db, stubCalendarWriteBack, conflicts);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({ title, startDate: { iso_date: "2027-01-17", approximate_text: null }, startTime: null, timezone: null, location: null, isAllDay: true, confidenceNotes: "clear" }, 0.9),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: title, bodyText: `${title} moved to January 17.` });

    const [inboxItem] = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.linkedResourceType, "schedule_conflict")))
      .orderBy(desc(schema.inboxItems.createdAt));
    const [conflictRow] = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, inboxItem!.linkedResourceId!));
    insertedEventIds.push(conflictRow!.involvedEventIds[0]!);

    await inbox.resolveDateDisagreement(inboxItem!.id, ownerUserId, "keep_calendar_date");

    const [unchangedCalendarEvent] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, calendarEventId));
    expect(unchangedCalendarEvent!.start.date).toBe("2027-01-10"); // untouched — the calendar date wins

    const [resolvedConflict] = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, conflictRow!.id));
    expect(resolvedConflict!.resolvedAt).not.toBeNull();
  });

  it("does NOT flag a disagreement for a low-confidence extraction", async () => {
    if (!dbAvailable) return;
    const title = "Low Confidence Appointment";
    await insertProviderSyncedEvent(title, "2027-02-01");

    const ai = new FakeModelProvider();
    const conflicts = new ConflictService(db, stubHouseholds);
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, conflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction(
        { title, startDate: { iso_date: "2027-02-08", approximate_text: null }, startTime: null, timezone: null, location: null, isAllDay: true, confidenceNotes: "vague" },
        0.6, // "needs_review" band under RISK_THRESHOLDS — below this check's high-confidence gate
      ),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: title, bodyText: `${title} maybe moved.` });

    const emailEvents = await db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.ownerUserId, ownerUserId), eq(schema.calendarEvents.source, "discovered_from_evidence"), eq(schema.calendarEvents.title, title)));
    const emailEvent = emailEvents.find((e) => e.providerEventId === null);
    if (emailEvent) insertedEventIds.push(emailEvent.id);

    const conflictRows = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.kind, "email_calendar_date_disagreement"));
    expect(emailEvent ? conflictRows.some((c) => c.involvedEventIds.includes(emailEvent.id)) : false).toBe(false);
  });
});
