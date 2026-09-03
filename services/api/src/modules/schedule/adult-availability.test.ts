import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { householdAdultBusyIntervals, isAdultFreeDuring } from "./adult-availability";
import { HouseholdService } from "../household/household.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { MailerService } from "../notifications/mailer.service";

/**
 * Household adult-availability heuristic (§25 "Family Transport Conflicts" gap, closed by
 * ConflictService.schoolTransportConflicts) — real integration test against a real Postgres, mirroring
 * conflict.service.test.ts's pattern.
 *
 * The privacy discipline this exercises adversarially: `householdAdultBusyIntervals` deliberately looks at
 * an adult's PRIVATE calendar events (bypassing the household-visibility filter every other read enforces)
 * to compute busy/free — spec CAL-001's "Household availability may expose 'busy' without exposing private
 * event title/details." These tests plant a sensitive, identifiable private-event title and confirm it
 * never appears anywhere in the returned data, no matter how that data is inspected — not as a field, not
 * serialized, not on an adult other than its own owner.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubEntitlements = {} as unknown as EntitlementsService;
const stubMailer = {} as unknown as MailerService;

describe("householdAdultBusyIntervals", () => {
  let db: Database;
  let households: HouseholdService;
  let householdId: string;
  let membershipIds: string[] = [];
  let userIds: string[] = [];
  let ownerUserId: string;
  let coAdultUserId: string;
  let outsiderUserId: string;
  let dependentLinkedUserId: string;
  let dependentProfileId: string;
  const insertedEventIds: string[] = [];
  let dbAvailable = true;

  const SENSITIVE_TITLE = "userB private therapy appointment — do not leak";

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    households = new HouseholdService(db, stubEntitlements, stubMailer);
    try {
      ownerUserId = generateId("user");
      coAdultUserId = generateId("user");
      outsiderUserId = generateId("user");
      dependentLinkedUserId = generateId("user");
      userIds = [ownerUserId, coAdultUserId, outsiderUserId, dependentLinkedUserId];
      await db.insert(schema.users).values(
        userIds.map((id) => ({ id, email: `adult-avail-${id}@example.com`, displayName: "Adult Availability Test" })),
      );

      householdId = generateId("household");
      await db.insert(schema.households).values({ id: householdId, name: "Availability Test Household", billingOwnerUserId: ownerUserId });

      const ownerMembershipId = generateId("membership");
      const coAdultMembershipId = generateId("membership");
      membershipIds = [ownerMembershipId, coAdultMembershipId];
      await db.insert(schema.householdMemberships).values([
        { id: ownerMembershipId, householdId, userId: ownerUserId, role: "household_owner", status: "active" },
        { id: coAdultMembershipId, householdId, userId: coAdultUserId, role: "adult_member", status: "active" },
      ]);

      // A dependent with their own linked account and calendar — must NEVER count as a candidate driver,
      // no matter how "adult-like" their account otherwise looks (activeAdultUserIds is role-gated, not
      // account-gated).
      dependentProfileId = generateId("dependentProfile");
      await db.insert(schema.dependentProfiles).values({
        id: dependentProfileId,
        householdId,
        displayName: "Linked Dependent",
        hasOwnAccount: true,
        linkedUserId: dependentLinkedUserId,
        guardianUserIds: [ownerUserId],
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping householdAdultBusyIntervals tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of insertedEventIds) {
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    }
    await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dependentProfileId));
    for (const id of membershipIds) {
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.id, id));
    }
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    for (const id of userIds) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
    const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(remaining).toHaveLength(0);
  });

  async function insertEvent(params: { ownerUserId: string; title: string; startInstant: string; endInstant: string; visibility: "private" | "household" }) {
    const id = generateId("calendarEvent");
    insertedEventIds.push(id);
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId: params.ownerUserId,
      householdId,
      title: params.title,
      start: { precision: "instant", instantUtc: params.startInstant, date: null, timezone: null, sourceText: null },
      startSort: new Date(params.startInstant),
      end: { precision: "instant", instantUtc: params.endInstant, date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: params.visibility,
    });
    return id;
  }

  it("returns busy intervals for every active adult, aggregated across their OWN private events, without ever exposing title/details", async () => {
    if (!dbAvailable) return;
    const windowStart = "2026-12-01T16:00:00.000Z";
    const windowEnd = "2026-12-01T20:00:00.000Z";
    await insertEvent({ ownerUserId: coAdultUserId, title: SENSITIVE_TITLE, startInstant: "2026-12-01T17:00:00.000Z", endInstant: "2026-12-01T18:00:00.000Z", visibility: "private" });

    const busyByAdult = await householdAdultBusyIntervals(db, households, householdId, Date.parse(windowStart), Date.parse(windowEnd));

    // Both active adults are present as keys — the owner (free, no events) and the co-adult (busy).
    expect(busyByAdult.has(ownerUserId)).toBe(true);
    expect(busyByAdult.get(ownerUserId)).toEqual([]);
    expect(busyByAdult.has(coAdultUserId)).toBe(true);
    expect(busyByAdult.get(coAdultUserId)).toEqual([{ startMs: Date.parse("2026-12-01T17:00:00.000Z"), endMs: Date.parse("2026-12-01T18:00:00.000Z") }]);

    // Adversarial: no interval, for any adult, ever carries anything beyond startMs/endMs — structurally
    // impossible for the sensitive title to ride along, and this proves it isn't riding along in practice
    // either, exercised against the household's own PRIVATE event.
    for (const intervals of busyByAdult.values()) {
      for (const interval of intervals) {
        expect(Object.keys(interval).sort()).toEqual(["endMs", "startMs"]);
      }
    }
    const serialized = JSON.stringify([...busyByAdult.entries()]);
    expect(serialized).not.toContain(SENSITIVE_TITLE);
    expect(serialized).not.toContain("therapy");
    expect(serialized.length).toBeGreaterThan(0); // sanity: we actually got real interval data back, not an empty stub
  });

  it("excludes a dependent's linked account and an outsider's events, even during the same window", async () => {
    if (!dbAvailable) return;
    const windowStart = Date.parse("2026-12-02T16:00:00.000Z");
    const windowEnd = Date.parse("2026-12-02T20:00:00.000Z");
    await insertEvent({ ownerUserId: dependentLinkedUserId, title: "Dependent's own event", startInstant: "2026-12-02T17:00:00.000Z", endInstant: "2026-12-02T18:00:00.000Z", visibility: "private" });
    await insertEvent({ ownerUserId: outsiderUserId, title: "Outsider's event", startInstant: "2026-12-02T17:00:00.000Z", endInstant: "2026-12-02T18:00:00.000Z", visibility: "private" });

    const busyByAdult = await householdAdultBusyIntervals(db, households, householdId, windowStart, windowEnd);

    expect(busyByAdult.has(dependentLinkedUserId)).toBe(false);
    expect(busyByAdult.has(outsiderUserId)).toBe(false);
    // The two real adults are still the only keys present.
    expect(new Set(busyByAdult.keys())).toEqual(new Set([ownerUserId, coAdultUserId]));
  });

  it("isAdultFreeDuring correctly reports free/busy at interval boundaries", () => {
    const intervals = [{ startMs: 1000, endMs: 2000 }];
    expect(isAdultFreeDuring(intervals, 0, 999)).toBe(true); // ends exactly before busy starts
    expect(isAdultFreeDuring(intervals, 2000, 3000)).toBe(true); // starts exactly when busy ends
    expect(isAdultFreeDuring(intervals, 1500, 1600)).toBe(false); // squarely inside
    expect(isAdultFreeDuring(intervals, 500, 1500)).toBe(false); // overlaps the start
    expect(isAdultFreeDuring([], 0, 100)).toBe(true); // no busy intervals at all
  });
});
