import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ListsService } from "./lists.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";
import type { MemoriesService } from "../memories/memories.service";

// ListsService only calls MemoriesService.evaluateSmartQuery, and only for smart lists (smartListQuery
// set) — none of this file's fixtures create one, so a stub that would throw if ever actually called is
// enough; see ListsService.listDetail's own doc comment for the smart-list branch this test doesn't exercise.
const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;

/**
 * FAM-005 "Shared lists" — real DB test covering the two things most likely to be silently wrong: the
 * FAM-006 delegation-scoped household visibility (same pattern as commerce/schedule) and item-level
 * "private when needed" filtering (a private item must not leak to another household member even when
 * they have full list access).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

function makeStubHouseholds(activeMembers: Set<string>, delegated: Map<string, string[]>, memberHouseholdId?: string): HouseholdService {
  return {
    delegatedHouseholdIds: async (userId: string) => delegated.get(userId) ?? [],
    isActiveMember: async (_householdId: string, userId: string) => activeMembers.has(userId),
    // Mirrors the real HouseholdService.activeHouseholdIds — ListsService.ownerOrDelegatedHousehold now
    // OR's this in alongside delegation (see that method's own doc comment for why: plain membership,
    // not just an explicit caregiver delegation, is what actually makes a shared list visible).
    activeHouseholdIds: async (userId: string) => (memberHouseholdId && activeMembers.has(userId) ? [memberHouseholdId] : []),
  } as unknown as HouseholdService;
}

describe("ListsService", () => {
  let db: Database;
  let ownerUserId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      memberUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `lists-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: memberUserId, email: `lists-member-${memberUserId}@example.com`, displayName: "Member" },
        { id: outsiderUserId, email: `lists-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ListsService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("shares a household list with a member, hides private items from them, and enforces owner-only edits", async () => {
    if (!dbAvailable) return;
    const activeMembers = new Set([ownerUserId, memberUserId]);
    const sharing = new SharingService(db);
    const ownerLists = new ListsService(db, makeStubHouseholds(activeMembers, new Map(), householdId), sharing, stubMemories);
    const memberLists = new ListsService(db, makeStubHouseholds(activeMembers, new Map(), householdId), sharing, stubMemories);
    const outsiderLists = new ListsService(db, makeStubHouseholds(new Set(), new Map(), householdId), sharing, stubMemories);

    const { id: listId } = await ownerLists.createList(ownerUserId, { name: "Groceries", kind: "grocery", householdId });

    await ownerLists.addItem(listId, ownerUserId, { label: "Milk" });
    await ownerLists.addItem(listId, ownerUserId, { label: "Surprise gift receipt", isPrivate: true });

    // The household member can see the list and its public item, but not the owner's private one.
    const memberView = await memberLists.listDetail(listId, memberUserId);
    expect(memberView.items.map((i) => i.label)).toEqual(["Milk"]);

    // The owner still sees both.
    const ownerView = await ownerLists.listDetail(listId, ownerUserId);
    expect(ownerView.items).toHaveLength(2);

    // An outsider with no membership/delegation has no access at all.
    await expect(outsiderLists.listDetail(listId, outsiderUserId)).rejects.toThrow();

    // A non-owner member cannot rename or delete the shared list.
    await expect(memberLists.updateList(listId, memberUserId, { name: "Hijacked" })).rejects.toThrow();
    await expect(memberLists.deleteList(listId, memberUserId)).rejects.toThrow();

    const milk = ownerView.items.find((i) => i.label === "Milk")!;
    // But the member CAN check off a public item on a list they have access to.
    await memberLists.updateItem(milk.id, memberUserId, { checked: true });
    const [checkedRow] = await db.select().from(schema.savedItems).where(eq(schema.savedItems.id, milk.id));
    expect(checkedRow?.checked).toBe(true);
    expect(checkedRow?.checkedByUserId).toBe(memberUserId);

    const summary = await ownerLists.listLists(ownerUserId);
    const thisList = summary.find((l) => l.id === listId);
    expect(thisList?.itemCounts).toEqual({ total: 2, checked: 1 });

    // The shared list must actually appear on a plain member's own list overview, not just be reachable
    // by ID — confirmed broken live before HouseholdService.activeHouseholdIds existed: a household member
    // with no explicit caregiver delegation got `[]` back from this exact call for a list their household
    // owned. Count also stays privacy-safe from their side (their own private item, not the owner's).
    const memberSummary = await memberLists.listLists(memberUserId);
    const memberThisList = memberSummary.find((l) => l.id === listId);
    expect(memberThisList?.itemCounts).toEqual({ total: 1, checked: 1 });

    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
  });
});
