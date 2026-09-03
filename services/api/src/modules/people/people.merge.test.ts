import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PeopleService } from "./people.service";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;

/**
 * PEO-002 "Person identity resolution" — findMergeCandidates is precision-first (never an automatic
 * merge — "ambiguous merges require review"), and mergePeople/unmergePeople must be fully reversible and
 * "preserve source mappings" (see PeopleService.mergePeople's own doc comment mirroring
 * AdminService.mergeMerchants). This proves: candidates are actually surfaced for matching email/phone/
 * name+organization, a merge repoints every satellite row (contactSources/aliases/notes/importantDates/
 * relationships, both relationship directions) onto the survivor, and unmerge restores them exactly.
 */
describe("PeopleService — merge candidates and reversible merge/unmerge", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let entitlements: EntitlementsService;
  let people: PeopleService;

  let ownerUserId: string;
  let otherOwnerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    people = new PeopleService(db, households, sharing);

    try {
      ownerUserId = generateId("user");
      otherOwnerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `peo-merge-owner-${ownerUserId}@example.com`, displayName: "Merge Owner" },
        { id: otherOwnerUserId, email: `peo-merge-other-${otherOwnerUserId}@example.com`, displayName: "Other Owner" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PeopleService merge tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // personMergeLineage rows reference people.id with no cascade (same as merchantMergeLineage/
    // entityMergeLineage — a lineage record is an audit trail, not disposable with its subjects), so it
    // must be cleared before the people rows it points at can be deleted.
    const owned = await db.select({ id: schema.people.id }).from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    for (const { id } of owned) {
      await db.delete(schema.personMergeLineage).where(eq(schema.personMergeLineage.survivingPersonId, id));
      await db.delete(schema.personMergeLineage).where(eq(schema.personMergeLineage.mergedPersonId, id));
    }
    await db.delete(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    await db.delete(schema.people).where(eq(schema.people.ownerUserId, otherOwnerUserId));
    for (const id of [ownerUserId, otherOwnerUserId]) await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  it("finds a matching-email candidate group, but never touches unrelated people", async () => {
    if (!dbAvailable) return;
    const { id: idA } = await people.create(ownerUserId, { displayName: "Jon Smith", emails: ["jon@example.com"] });
    const { id: idB } = await people.create(ownerUserId, { displayName: "Jonathan Smith", emails: ["JON@Example.com "] });
    const { id: idC } = await people.create(ownerUserId, { displayName: "Totally Unrelated" });

    const candidates = await people.findMergeCandidates(ownerUserId);
    const emailGroup = candidates.find((c) => c.reason === "matching_email" && c.personIds.includes(idA));
    expect(emailGroup).toBeDefined();
    expect(emailGroup!.personIds.sort()).toEqual([idA, idB].sort());
    expect(candidates.some((c) => c.personIds.includes(idC))).toBe(false);
  });

  it("finds a matching-phone candidate group using normalized digits (formatting differences don't block the match)", async () => {
    if (!dbAvailable) return;
    const { id: idA } = await people.create(ownerUserId, { displayName: "Plumber A", phones: ["(555) 123-4567"] });
    const { id: idB } = await people.create(ownerUserId, { displayName: "Plumber B", phones: ["555.123.4567"] });
    const candidates = await people.findMergeCandidates(ownerUserId);
    const phoneGroup = candidates.find((c) => c.reason === "matching_phone" && c.personIds.includes(idA));
    expect(phoneGroup?.personIds.sort()).toEqual([idA, idB].sort());
  });

  it("finds a matching-name-and-organization candidate group even with no shared alias", async () => {
    if (!dbAvailable) return;
    const { id: orgId } = await people.createOrganization(ownerUserId, { name: "Acme Plumbing" });
    const { id: idA } = await people.create(ownerUserId, { displayName: "Sam Rivera", organizationId: orgId });
    const { id: idB } = await people.create(ownerUserId, { displayName: "sam rivera", organizationId: orgId });
    const candidates = await people.findMergeCandidates(ownerUserId);
    const nameGroup = candidates.find((c) => c.reason === "matching_name_and_organization" && c.personIds.includes(idA));
    expect(nameGroup?.personIds.sort()).toEqual([idA, idB].sort());
  });

  it("mergePeople repoints every satellite row onto the survivor and is exactly reversed by unmergePeople", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await people.create(ownerUserId, { displayName: "Survivor Contact", emails: ["survivor@example.com"] });
    const { id: mergedId } = await people.create(ownerUserId, { displayName: "Duplicate Contact", emails: ["duplicate@example.com"] });

    await people.addNote(mergedId, ownerUserId, { body: "Met at the block party" });
    await people.addImportantDate(mergedId, ownerUserId, { label: "Birthday", dateIso: "2026-03-15" });
    const { id: relationshipId } = await people.addRelationship(survivorId, ownerUserId, { toPersonId: mergedId, label: "knows" });
    const mergedNoteCountBefore = (await db.select().from(schema.personNotes).where(eq(schema.personNotes.personId, mergedId))).length;
    expect(mergedNoteCountBefore).toBe(1);

    const result = await people.mergePeople(survivorId, mergedId, ownerUserId);
    expect(result.repointedNoteCount).toBe(1);
    expect(result.repointedImportantDateCount).toBe(1);
    expect(result.repointedAliasCount).toBe(1);
    // relationshipId pointed FROM survivor TO merged — repointed to point at itself is nonsensical, so
    // mergePeople repoints the `toPersonId` side onto the survivor (relationshipId now points survivor->survivor).
    expect(result.repointedRelationshipCount).toBe(1);

    const [mergedRow] = await db.select().from(schema.people).where(eq(schema.people.id, mergedId));
    expect(mergedRow!.mergedIntoPersonId).toBe(survivorId);
    // Merged-away person is excluded from ordinary list/detail queries but not hard-deleted.
    expect(mergedRow!.deletedAt).toBeNull();
    await expect(people.detail(mergedId, ownerUserId)).rejects.toMatchObject({ response: { code: "PERSON_NOT_FOUND" } });
    const list = await people.list(ownerUserId);
    expect(list.map((p) => p.id)).not.toContain(mergedId);
    expect(list.map((p) => p.id)).toContain(survivorId);

    // Every satellite row now points at the survivor.
    const notesOnSurvivor = await db.select().from(schema.personNotes).where(eq(schema.personNotes.personId, survivorId));
    expect(notesOnSurvivor.map((n) => n.body)).toContain("Met at the block party");
    const datesOnSurvivor = await db.select().from(schema.personImportantDates).where(eq(schema.personImportantDates.personId, survivorId));
    expect(datesOnSurvivor.map((d) => d.label)).toContain("Birthday");
    const aliasesOnSurvivor = await db.select().from(schema.aliases).where(eq(schema.aliases.personId, survivorId));
    expect(aliasesOnSurvivor.map((a) => a.value)).toContain("duplicate@example.com");
    const [relAfterMerge] = await db.select().from(schema.personRelationships).where(eq(schema.personRelationships.id, relationshipId));
    expect(relAfterMerge!.toPersonId).toBe(survivorId);

    // --- Reverse it ---
    const restore = await people.unmergePeople(result.lineageId, ownerUserId);
    expect(restore.restoredNoteCount).toBe(1);
    expect(restore.restoredImportantDateCount).toBe(1);
    expect(restore.restoredAliasCount).toBe(1);
    expect(restore.restoredRelationshipCount).toBe(1);

    const [mergedRestored] = await db.select().from(schema.people).where(eq(schema.people.id, mergedId));
    expect(mergedRestored!.mergedIntoPersonId).toBeNull();
    const restoredDetail = await people.detail(mergedId, ownerUserId);
    expect(restoredDetail.person.id).toBe(mergedId);

    const notesOnMergedAfterRestore = await db.select().from(schema.personNotes).where(eq(schema.personNotes.personId, mergedId));
    expect(notesOnMergedAfterRestore.map((n) => n.body)).toContain("Met at the block party");
    const datesOnMergedAfterRestore = await db.select().from(schema.personImportantDates).where(eq(schema.personImportantDates.personId, mergedId));
    expect(datesOnMergedAfterRestore.map((d) => d.label)).toContain("Birthday");
    const aliasesOnMergedAfterRestore = await db.select().from(schema.aliases).where(eq(schema.aliases.personId, mergedId));
    expect(aliasesOnMergedAfterRestore.map((a) => a.value)).toContain("duplicate@example.com");
    const [relAfterRestore] = await db.select().from(schema.personRelationships).where(eq(schema.personRelationships.id, relationshipId));
    expect(relAfterRestore!.toPersonId).toBe(mergedId);

    // Double-unmerge is rejected, not silently re-applied.
    await expect(people.unmergePeople(result.lineageId, ownerUserId)).rejects.toMatchObject({ response: { code: "ALREADY_UNMERGED" } });
  });

  it("rejects merging your own person with one you don't own, and rejects merging a person into itself", async () => {
    if (!dbAvailable) return;
    const { id: mineId } = await people.create(ownerUserId, { displayName: "Mine" });
    const { id: theirsId } = await people.create(otherOwnerUserId, { displayName: "Theirs" });
    await expect(people.mergePeople(mineId, theirsId, ownerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await expect(people.mergePeople(mineId, mineId, ownerUserId)).rejects.toMatchObject({ response: { code: "SAME_PERSON" } });
  });

  it("unmergePeople rejects an actor who didn't perform the original merge", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await people.create(ownerUserId, { displayName: "Survivor 2" });
    const { id: mergedId } = await people.create(ownerUserId, { displayName: "Merged 2" });
    const { lineageId } = await people.mergePeople(survivorId, mergedId, ownerUserId);
    await expect(people.unmergePeople(lineageId, otherOwnerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });
});
