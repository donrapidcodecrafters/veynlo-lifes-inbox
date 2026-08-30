import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { CommerceService } from "./commerce.service";

/**
 * §40.3 return state machine — previously a total stub: returnCases.state was written once at creation
 * ("eligible") and never updated by anything, with no mutation endpoint at all. Real DB-backed proof the
 * new setReturnCaseState mutation actually works, validates its input, and enforces ownership.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const commerce = new CommerceService(db, {} as never); // HouseholdService — unreached by setReturnCaseState (strict-ownership, not delegate-allowed)

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
  await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
  await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId]));
});

describe("CommerceService.setReturnCaseState", () => {
  it("rejects a state outside the user-settable set (e.g. the ingestion-only 'eligible')", async () => {
    await expect(commerce.setReturnCaseState(returnCaseId, ownerId, "eligible")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a nonexistent return case", async () => {
    await expect(commerce.setReturnCaseState(generateId("returnCase"), ownerId, "kept")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects a stranger trying to set state on someone else's return", async () => {
    await expect(commerce.setReturnCaseState(returnCaseId, strangerId, "kept")).rejects.toBeInstanceOf(BadRequestException);
    const [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("eligible"); // untouched
  });

  it("the real owner can move the return through its real states", async () => {
    await commerce.setReturnCaseState(returnCaseId, ownerId, "return_started");
    let [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("return_started");

    await commerce.setReturnCaseState(returnCaseId, ownerId, "returned");
    [row] = await db.select({ state: schema.returnCases.state }).from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(row?.state).toBe("returned");
  });
});
