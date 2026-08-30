import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { DocumentsService } from "./documents.service";

/**
 * §HH-002 "object-level privacy badge" — same real gap as ScheduleService's identical fix: the
 * delegated-household read path already correctly excluded visibility:"private" documents, but nothing
 * anywhere ever set a document's visibility to anything else, so the caregiver-delegation feature
 * (documents:read) was functionally inert. Real DB-backed proof the new setVisibility mutation works.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const documents = new DocumentsService(db, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);

const ownerId = generateId("user");
const strangerId = generateId("user");
const householdId = generateId("household");
const docInHouseholdId = generateId("document");
const docSoloId = generateId("document");

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
  ]);
  await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerId });
  await db.insert(schema.documents).values([
    { id: docInHouseholdId, ownerUserId: ownerId, householdId, documentType: "receipt", title: "Household doc", tags: [] },
    { id: docSoloId, ownerUserId: ownerId, householdId: null, documentType: "receipt", title: "Solo doc", tags: [] },
  ]);
});

afterAll(async () => {
  await db.delete(schema.documents).where(inArray(schema.documents.id, [docInHouseholdId, docSoloId]));
  await db.delete(schema.households).where(eq(schema.households.id, householdId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId]));
});

describe("DocumentsService.setVisibility", () => {
  it("refuses a stranger trying to change visibility on someone else's document", async () => {
    await expect(documents.setVisibility(docInHouseholdId, strangerId, "household")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses setting 'household' visibility on a document with no household at all", async () => {
    await expect(documents.setVisibility(docSoloId, ownerId, "household")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the real owner can genuinely make a household document visible, then private again", async () => {
    await documents.setVisibility(docInHouseholdId, ownerId, "household");
    let [row] = await db.select({ visibility: schema.documents.visibility }).from(schema.documents).where(eq(schema.documents.id, docInHouseholdId));
    expect(row?.visibility).toBe("household");

    await documents.setVisibility(docInHouseholdId, ownerId, "private");
    [row] = await db.select({ visibility: schema.documents.visibility }).from(schema.documents).where(eq(schema.documents.id, docInHouseholdId));
    expect(row?.visibility).toBe("private");
  });
});
