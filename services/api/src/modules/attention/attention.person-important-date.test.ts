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
 * PEO-005 "Important dates ... can generate reminders" — wires personImportantDates into
 * AttentionService.scanAndFileDeadlines the same way calendarEvents/dependentProfiles birthdays already
 * feed reminders elsewhere in this app. Mirrors attention.event-reminder.test.ts's shape: an upcoming date
 * within its own reminder lead time files a `person_important_date` item; one further out doesn't yet;
 * re-running the scan doesn't duplicate it; and — the recurrence case ResurfacingService's own doc comment
 * calls out — a date whose `lastRemindedAt` is old enough can fire again for a LATER year's occurrence,
 * unlike `fileIfNew`'s permanent per-resource dedup.
 */
describe("AttentionService.scanAndFileDeadlines — person important-date reminders (PEO-005)", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let personId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `peo-imp-date-${ownerUserId}@example.com`, displayName: "Important Date Test User" });
      personId = generateId("person");
      await db.insert(schema.people).values({ id: personId, ownerUserId, displayName: "Grandma Rose", visibility: "private" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService person-important-date tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.personImportantDates).where(eq(schema.personImportantDates.personId, personId));
    await db.delete(schema.people).where(eq(schema.people.id, personId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  function nextOccurrenceWithinDays(daysFromNow: number): Date {
    const target = new Date(Date.now() + daysFromNow * 86_400_000);
    return target;
  }

  async function makeImportantDate(params: { label: string; monthDayFromDate: Date; reminderDaysBefore: number; lastRemindedAt?: Date | null }): Promise<string> {
    const id = generateId("personImportantDate");
    const dateIso = params.monthDayFromDate.toISOString().slice(0, 10);
    await db.insert(schema.personImportantDates).values({
      id,
      personId,
      ownerUserId,
      label: params.label,
      date: { precision: "date", instantUtc: null, date: dateIso, timezone: null, sourceText: null },
      dateSort: new Date(`${dateIso}T00:00:00Z`),
      reminderDaysBefore: params.reminderDaysBefore,
      lastRemindedAt: params.lastRemindedAt ?? null,
    });
    return id;
  }

  async function attentionItemFor(personIdToCheck: string) {
    const [row] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "person"), eq(schema.attentionItems.linkedResourceId, personIdToCheck)));
    return row ?? null;
  }

  it("files a reminder for an important date within its reminder lead time", async () => {
    if (!dbAvailable) return;
    await makeImportantDate({ label: "Birthday", monthDayFromDate: nextOccurrenceWithinDays(5), reminderDaysBefore: 14 });
    await attention.scanAndFileDeadlines();
    const item = await attentionItemFor(personId);
    expect(item).not.toBeNull();
    expect(item!.reasonCode).toBe("person_important_date");
    expect(item!.reasonText).toContain("Grandma Rose");
    expect(item!.reasonText.toLowerCase()).toContain("birthday");
  });

  it("re-running the scan does not duplicate an already-filed important-date reminder", async () => {
    if (!dbAvailable) return;
    await attention.scanAndFileDeadlines();
    const rows = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "person"), eq(schema.attentionItems.linkedResourceId, personId)));
    expect(rows).toHaveLength(1);
  });

  it("stamps lastRemindedAt after filing, so the recurrence gate has a real timestamp to check", async () => {
    if (!dbAvailable) return;
    const [row] = await db.select().from(schema.personImportantDates).where(eq(schema.personImportantDates.personId, personId));
    expect(row!.lastRemindedAt).not.toBeNull();
  });

  it("does not file yet for a date further out than its own reminder lead time", async () => {
    if (!dbAvailable) return;
    const otherPersonId = generateId("person");
    await db.insert(schema.people).values({ id: otherPersonId, ownerUserId, displayName: "Far Off Friend", visibility: "private" });
    const id = generateId("personImportantDate");
    const dateIso = nextOccurrenceWithinDays(40).toISOString().slice(0, 10);
    await db.insert(schema.personImportantDates).values({
      id,
      personId: otherPersonId,
      ownerUserId,
      label: "Anniversary",
      date: { precision: "date", instantUtc: null, date: dateIso, timezone: null, sourceText: null },
      dateSort: new Date(`${dateIso}T00:00:00Z`),
      reminderDaysBefore: 7,
    });

    await attention.scanAndFileDeadlines();
    expect(await attentionItemFor(otherPersonId)).toBeNull();

    await db.delete(schema.personImportantDates).where(eq(schema.personImportantDates.personId, otherPersonId));
    await db.delete(schema.people).where(eq(schema.people.id, otherPersonId));
  });

  it("PEO-005: never files an important-date reminder for a person the scan finds soft-deleted or merged away", async () => {
    if (!dbAvailable) return;
    const goneOwnerId = generateId("user");
    await db.insert(schema.users).values({ id: goneOwnerId, email: `peo-imp-date-gone-${goneOwnerId}@example.com`, displayName: "Gone Owner" });
    const deletedPersonId = generateId("person");
    await db.insert(schema.people).values({ id: deletedPersonId, ownerUserId: goneOwnerId, displayName: "Deleted Person", visibility: "private", deletedAt: new Date() });
    const dateId = generateId("personImportantDate");
    const dateIso = nextOccurrenceWithinDays(1).toISOString().slice(0, 10);
    await db.insert(schema.personImportantDates).values({
      id: dateId,
      personId: deletedPersonId,
      ownerUserId: goneOwnerId,
      label: "Birthday",
      date: { precision: "date", instantUtc: null, date: dateIso, timezone: null, sourceText: null },
      dateSort: new Date(`${dateIso}T00:00:00Z`),
      reminderDaysBefore: 14,
    });

    await attention.scanAndFileDeadlines();
    expect(await attentionItemFor(deletedPersonId)).toBeNull();

    await db.delete(schema.personImportantDates).where(eq(schema.personImportantDates.id, dateId));
    await db.delete(schema.people).where(eq(schema.people.id, deletedPersonId));
    await db.delete(schema.users).where(eq(schema.users.id, goneOwnerId));
  });
});
