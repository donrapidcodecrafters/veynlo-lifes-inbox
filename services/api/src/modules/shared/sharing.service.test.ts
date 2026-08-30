import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { SharingService } from "./sharing.service";
import { ScheduleService } from "../schedule/schedule.service";

/** §54.2 launch criteria #5 "no unauthorized household/private data can leak through... shares" — real
 * test against local Postgres. SharingService's own doc comment says createShareLink/revokeShareLinks
 * trust the CALLER to have already checked ownership (each domain service does its own check before
 * calling in) — verified here via ScheduleService's real implementation, one real caller, not assumed
 * correct from the comment alone. listMyShareLinks/revokeShareLinkById are the two methods this service
 * enforces ownership on directly, tested here too. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const db: Database = createDbClient(DATABASE_URL);
const sharing = new SharingService(db);
const schedule = new ScheduleService(db, {} as never, {} as never, {} as never, sharing);

const ownerId = generateId("user");
const strangerId = generateId("user");
const eventId = generateId("calendarEvent");
let shareLinkId: string;

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
  ]);
  await db.insert(schema.calendarEvents).values({
    id: eventId,
    ownerUserId: ownerId,
    title: "Test event",
    start: { date: "2026-09-15", precision: "date", instantUtc: null, timezone: null, sourceText: null },
    startSort: new Date("2026-09-15"),
    source: "manual",
  });
  await sharing.createShareLink("calendar_event", eventId, ownerId);
  const [link] = await db
    .select({ id: schema.shareLinks.id })
    .from(schema.shareLinks)
    .where(eq(schema.shareLinks.resourceId, eventId))
    .limit(1);
  shareLinkId = link!.id;
});

afterAll(async () => {
  await db.delete(schema.shareLinks).where(eq(schema.shareLinks.resourceId, eventId));
  await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId]));
});

describe("Sharing — cross-user isolation", () => {
  it("listMyShareLinks never returns another user's share links", async () => {
    const ownerLinks = await sharing.listMyShareLinks(ownerId);
    expect(ownerLinks.map((l) => l.id)).toContain(shareLinkId);

    const strangerLinks = await sharing.listMyShareLinks(strangerId);
    expect(strangerLinks.map((l) => l.id)).not.toContain(shareLinkId);
  });

  it("revokeShareLinkById cannot revoke a share link that isn't the caller's own", async () => {
    await sharing.revokeShareLinkById(shareLinkId, strangerId);
    const [link] = await db.select({ revokedAt: schema.shareLinks.revokedAt }).from(schema.shareLinks).where(eq(schema.shareLinks.id, shareLinkId)).limit(1);
    expect(link?.revokedAt).toBeNull();
  });

  it("ScheduleService.createShareLink rejects a caller who doesn't own the event", async () => {
    await expect(schedule.createShareLink(eventId, strangerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("ScheduleService.createShareLink succeeds for the real owner", async () => {
    const result = await schedule.createShareLink(eventId, ownerId);
    expect(result.url).toContain("/shared/");
  });
});
