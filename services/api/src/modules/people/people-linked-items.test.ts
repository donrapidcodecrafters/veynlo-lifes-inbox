import { describe, expect, it, afterAll } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { CommerceService } from "../commerce/commerce.service";
import { ScheduleService } from "../schedule/schedule.service";
import { SharingService } from "../shared/sharing.service";
import { SearchIndexService } from "../search/search-index.service";
import { PeopleService } from "./people.service";

/**
 * PEO-004 "person linkage" — previously nothing linked a person entity to the purchases/bills/warranties/
 * appointments they're associated with (a contractor, a gift recipient) at all. Real proof the link/unlink
 * mutations (CommerceService.setPersonLink, ScheduleService.setEventPersonLink) and the reverse lookup
 * (PeopleService.linkedItems) all work together against a real database.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const commerce = new CommerceService(db, {} as never);
const schedule = new ScheduleService(db, {} as never, {} as never, {} as never, {} as never, {} as never, new SharingService(db));
const people = new PeopleService(db, new SearchIndexService(db));

const ownerId = generateId("user");
const strangerId = generateId("user");
const personId = generateId("entity");
const purchaseId = generateId("purchase");
const billId = generateId("bill");
const warrantyId = generateId("warranty");
const eventId = generateId("calendarEvent");

afterAll(async () => {
  await db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, [eventId]));
  await db.delete(schema.warranties).where(inArray(schema.warranties.id, [warrantyId]));
  await db.delete(schema.bills).where(inArray(schema.bills.id, [billId]));
  await db.delete(schema.purchases).where(inArray(schema.purchases.id, [purchaseId]));
  await db.delete(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, personId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId]));
});

async function setup() {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
  ]);
  await db.insert(schema.canonicalEntities).values({
    id: personId,
    type: "person",
    ownerUserId: ownerId,
    displayLabel: "Jane the Contractor",
    aliases: [],
    lifecycleState: "active",
  });
  await db.insert(schema.purchases).values({
    id: purchaseId,
    ownerUserId: ownerId,
    purchaseDate: { precision: "date", date: "2026-08-01", instantUtc: null, timezone: null, sourceText: null },
    state: "kept",
    confidenceBand: "verified",
  });
  await db.insert(schema.bills).values({
    id: billId,
    ownerUserId: ownerId,
    billerLabel: "Jane's Plumbing",
    dueDate: { precision: "date", date: "2026-09-01", instantUtc: null, timezone: null, sourceText: null },
  });
  await db.insert(schema.warranties).values({
    id: warrantyId,
    ownerUserId: ownerId,
    productLabel: "Water heater install",
    expirationDate: { precision: "date", date: "2028-08-01", instantUtc: null, timezone: null, sourceText: null },
  });
  await db.insert(schema.calendarEvents).values({
    id: eventId,
    ownerUserId: ownerId,
    title: "Jane comes to fix the sink",
    start: { precision: "date", date: "2026-09-10", instantUtc: null, timezone: null, sourceText: null },
    source: "manual",
  });
}

describe("Person linkage (PEO-004)", () => {
  it("links a purchase, bill, warranty, and event to a person, all real-DB verified via PeopleService.linkedItems", async () => {
    await setup();

    await commerce.setPersonLink("purchase", purchaseId, ownerId, personId, true);
    await commerce.setPersonLink("bill", billId, ownerId, personId, true);
    await commerce.setPersonLink("warranty", warrantyId, ownerId, personId, true);
    await schedule.setEventPersonLink(eventId, ownerId, personId, true);

    const linked = await people.linkedItems(personId, ownerId);
    expect(linked.purchases.map((p) => p.id)).toEqual([purchaseId]);
    expect(linked.bills.map((b) => b.id)).toEqual([billId]);
    expect(linked.warranties.map((w) => w.id)).toEqual([warrantyId]);
    expect(linked.events.map((e) => e.id)).toEqual([eventId]);
  });

  it("unlinking removes it from linkedItems without affecting other links", async () => {
    const linkedBefore = await people.linkedItems(personId, ownerId);
    expect(linkedBefore.purchases.length).toBe(1);

    await commerce.setPersonLink("purchase", purchaseId, ownerId, personId, false);

    const linkedAfter = await people.linkedItems(personId, ownerId);
    expect(linkedAfter.purchases).toEqual([]);
    expect(linkedAfter.bills.map((b) => b.id)).toEqual([billId]); // untouched
  });

  it("linking twice is idempotent — no duplicate entries in linkedEntityIds", async () => {
    await commerce.setPersonLink("bill", billId, ownerId, personId, true); // already linked from setup
    const [row] = await db.select({ linkedEntityIds: schema.bills.linkedEntityIds }).from(schema.bills).where(eq(schema.bills.id, billId));
    expect(row?.linkedEntityIds.filter((id) => id === personId).length).toBe(1);
  });

  it("rejects linking a resource the caller doesn't own", async () => {
    // The stranger doesn't own `personId` either, so this must fail on the person check first (real
    // ownership boundary either way) -- give the stranger their own person to isolate the resource check.
    const strangerPersonId = generateId("entity");
    await db.insert(schema.canonicalEntities).values({ id: strangerPersonId, type: "person", ownerUserId: strangerId, displayLabel: "Stranger's contact", aliases: [], lifecycleState: "active" });
    await expect(commerce.setPersonLink("bill", billId, strangerId, strangerPersonId, true)).rejects.toBeInstanceOf(BadRequestException);
    await db.delete(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, strangerPersonId));
  });

  it("rejects linking to a person the caller doesn't own", async () => {
    await expect(commerce.setPersonLink("warranty", warrantyId, ownerId, generateId("entity"), true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects an event link/unlink from a non-owner", async () => {
    const strangerPersonId = generateId("entity");
    await db.insert(schema.canonicalEntities).values({ id: strangerPersonId, type: "person", ownerUserId: strangerId, displayLabel: "Stranger's contact", aliases: [], lifecycleState: "active" });
    await expect(schedule.setEventPersonLink(eventId, strangerId, strangerPersonId, true)).rejects.toBeInstanceOf(BadRequestException);
    await db.delete(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, strangerPersonId));
  });
});
