import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { HistoryService } from "./history.service";

/**
 * Real, previously-missing gap (surfaced by this session's security audit): addNote never verified the
 * caller owned resourceId before attaching a note to it — any authenticated user could attach a note to
 * an arbitrary resourceId, including one belonging to a different user. Real DB-backed proof the ownership
 * check now blocks that, for the two resource types with the trickiest ownership paths (a direct
 * ownerUserId column, and one resolved through a parent row).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const history = new HistoryService(db, {} as never); // DocumentsService — unreached by addNote

const ownerId = generateId("user");
const strangerId = generateId("user");
const purchaseId = generateId("purchase");
const returnCaseId = generateId("returnCase");

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
  ]);
  await db.insert(schema.purchases).values({
    id: purchaseId,
    ownerUserId: ownerId,
    orderNumber: "ORDER-1",
    state: "confirmed",
    confidenceBand: "verified",
    purchaseDate: { date: "2026-08-01", precision: "date", instantUtc: null, timezone: null, sourceText: null },
  });
  await db.insert(schema.returnCases).values({
    id: returnCaseId,
    purchaseId,
    deadline: { date: "2026-09-01", precision: "date", instantUtc: null, timezone: null, sourceText: null },
  });
});

afterAll(async () => {
  await db.delete(schema.objectNotes).where(eq(schema.objectNotes.resourceId, purchaseId));
  await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
  await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
  await db.delete(schema.users).where(eq(schema.users.id, strangerId));
});

describe("HistoryService.addNote — real ownership enforcement", () => {
  it("the real owner can attach a note to their own purchase", async () => {
    const note = await history.addNote(ownerId, "purchase", purchaseId, "A real note");
    expect(note.noteText).toBe("A real note");
  });

  it("a stranger cannot attach a note to someone else's purchase (direct ownerUserId column)", async () => {
    await expect(history.addNote(strangerId, "purchase", purchaseId, "Trying to attach")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("a stranger cannot attach a note to someone else's return case (ownership resolved through the parent purchase)", async () => {
    await expect(history.addNote(strangerId, "return_case", returnCaseId, "Trying to attach")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("the real owner CAN attach a note to their own return case", async () => {
    const note = await history.addNote(ownerId, "return_case", returnCaseId, "Real return note");
    expect(note.noteText).toBe("Real return note");
  });

  it("a nonexistent resourceId is rejected the same way as someone else's real resource", async () => {
    await expect(history.addNote(ownerId, "purchase", generateId("purchase"), "orphan note")).rejects.toBeInstanceOf(NotFoundException);
  });
});
