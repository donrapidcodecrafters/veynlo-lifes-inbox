import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import type { CreateShareLinkDto, ResourceGrantRight } from "../sharing/dto";
import { MemoriesService } from "../memories/memories.service";
import type { SmartListQuery } from "../memories/dto";
import type { CreateListDto, CreateSavedItemDto, UpdateListDto, UpdateSavedItemDto } from "./dto";

/**
 * FAM-005 "Shared lists" — spec: "Groceries, packing, household maintenance, gifts, school supplies,
 * trip prep and custom lists... Items can be assigned, checked, linked to saved product/purchase, and
 * private when needed." Built on the pre-reserved `lists`/`saved_items` tables (see schema/lists.ts).
 */
@Injectable()
export class ListsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(MemoriesService) private readonly memories: MemoriesService,
  ) {}

  /** Same FAM-006 delegation-scoped visibility pattern as CommerceService/ScheduleService/DocumentsService's
   * own `ownerOrDelegatedHousehold` — kept as a local copy rather than shared, matching their precedent.
   * OR's in plain active membership alongside delegation (see HouseholdService.activeHouseholdIds's own
   * doc comment) — without it, a shared household list never appeared in a member's own `GET /v1/lists`
   * even though `assertListAccess` below already let them open it directly by ID, confirmed live. */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "lists:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    if (householdIds.length === 0) return eq(ownerCol, userId);
    return or(eq(ownerCol, userId), inArray(householdCol, householdIds))!;
  }

  /** Phase 2 §52.2 "object sharing" — a direct resourceGrant on this specific list is an access path in
   * its own right, alongside ownership/household visibility, same as DocumentsService/CommerceService/
   * AssetsService's own access checks. */
  private async assertListAccess(listId: string, userId: string) {
    const [list] = await this.db.select().from(schema.lists).where(eq(schema.lists.id, listId)).limit(1);
    if (!list) throw new NotFoundException({ code: "LIST_NOT_FOUND", message: "List not found." });
    if (list.ownerUserId === userId) return list;
    if (list.householdId) {
      const delegatedIds = await this.households.delegatedHouseholdIds(userId, "lists:read");
      if (delegatedIds.includes(list.householdId)) return list;
      if (await this.households.isActiveMember(list.householdId, userId)) return list;
    }
    if (await this.sharing.hasActiveGrant("list", listId, userId)) return list;
    throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this list." });
  }

  /**
   * SHARE-001 "manage = edit + delete + can grant/revoke others' access" — a "manage"-right grantee gets
   * everything the owner gets here (create/list grants and links, revoke any of them), but never ownership
   * itself. Used by every sharing-endpoint write below now that a grant's `right` is actually enforced;
   * used to be owner-only (see this class's own git history / SHARE-001 doc entry).
   */
  private async assertOwnedOrManagedListForSharing(listId: string, userId: string) {
    const [list] = await this.db.select().from(schema.lists).where(eq(schema.lists.id, listId)).limit(1);
    if (!list) throw new NotFoundException({ code: "LIST_NOT_FOUND", message: "List not found." });
    if (list.ownerUserId === userId) return list;
    if (await this.sharing.hasGrantAtLeast("list", listId, userId, "manage")) return list;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the list owner or a manager can share it." });
  }

  /** True when `userId` reaches this list through ownership or household visibility (not a direct grant)
   * — the write paths below that are already collaborative for a household (e.g. addItem) must stay that
   * way unchanged; only a grant-based accessor is newly subject to the `right` check. */
  private async isOwnerOrHousehold(list: typeof schema.lists.$inferSelect, userId: string): Promise<boolean> {
    if (list.ownerUserId === userId) return true;
    if (!list.householdId) return false;
    const delegatedIds = await this.households.delegatedHouseholdIds(userId, "lists:read");
    if (delegatedIds.includes(list.householdId)) return true;
    return this.households.isActiveMember(list.householdId, userId);
  }

  async createList(userId: string, dto: CreateListDto) {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    const id = generateId("list");
    await this.db.insert(schema.lists).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      name: dto.name,
      kind: dto.kind ?? "custom",
      smartListQuery: dto.smartListQuery ?? null,
    });
    return { id };
  }

  async listLists(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("list", userId);
    const baseCondition = await this.ownerOrDelegatedHousehold(userId, schema.lists.ownerUserId, schema.lists.householdId);
    const accessCondition = grantedIds.length > 0 ? or(baseCondition, inArray(schema.lists.id, grantedIds))! : baseCondition;
    const rows = await this.db
      .select()
      .from(schema.lists)
      .where(and(accessCondition, isNull(schema.lists.archivedAt)));

    if (rows.length === 0) return [];
    const items = await this.db
      .select({
        listId: schema.savedItems.listId,
        checked: schema.savedItems.checked,
        isPrivate: schema.savedItems.isPrivate,
        createdByUserId: schema.savedItems.createdByUserId,
      })
      .from(schema.savedItems)
      .where(inArray(schema.savedItems.listId, rows.map((r) => r.id)));
    const counts = new Map<string, { total: number; checked: number }>();
    for (const item of items) {
      // Same visibility rule as listDetail's own `visibleItems` filter — someone else's private item on
      // an otherwise-shared list must stay invisible everywhere, not just hidden from the item list while
      // still padding out this screen's total/checked counts (confirmed live: a household member's
      // private addition silently inflated the list-overview count for every other member, which both
      // reads as a wrong number and, on a list with nothing else added, tips off that *something* private
      // exists — the exact leak `isPrivate` exists to prevent).
      if (item.isPrivate && item.createdByUserId !== userId) continue;
      const current = counts.get(item.listId) ?? { total: 0, checked: 0 };
      current.total += 1;
      if (item.checked) current.checked += 1;
      counts.set(item.listId, current);
    }
    return rows
      .map((row) => ({ ...row, itemCounts: counts.get(row.id) ?? { total: 0, checked: 0 } }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * §29.1 SAVE-003 "Smart lists." A smart list (`list.smartListQuery` set) has no rows in `saved_items` at
   * all — its "items" are computed live from `saved_memories` via MemoriesService.evaluateSmartQuery,
   * scoped to the REQUESTING user's own memories only (memories are private by default; see that method's
   * own doc comment on why a smart list can't show another household member's private saves just because
   * the list definition itself is shared). Returned under a separate `matchedMemories` key rather than
   * `items` — a saved-memory row has a genuinely different shape (category/pinned/source, no checked/
   * assignedToUserId) than a manual list's savedItems row, and conflating them would misrepresent one as
   * the other rather than just being empty.
   */
  async listDetail(listId: string, userId: string) {
    const list = await this.assertListAccess(listId, userId);
    // SHARE-001 "optional message" — a grant-based visitor (not the owner/a household member) sees any
    // note the granter left, e.g. "Note from Dana: this is the camping list for next weekend." Null for
    // owner/household access (there's no grant to read a message off of) and for a grant with no message.
    const sharedNote = (await this.isOwnerOrHousehold(list, userId)) ? null : await this.sharing.grantMessage("list", listId, userId);
    if (list.smartListQuery) {
      const matchedMemories = await this.memories.evaluateSmartQuery(userId, list.smartListQuery as SmartListQuery);
      return { list, items: [], matchedMemories, sharedNote };
    }
    const items = await this.db
      .select()
      .from(schema.savedItems)
      .where(eq(schema.savedItems.listId, listId))
      .orderBy(asc(schema.savedItems.position), asc(schema.savedItems.createdAt));
    // Spec: "private when needed" — a private item is visible only to whoever added it, even to other
    // members of an otherwise-shared household list (e.g. a surprise gift on a shared gift list).
    const visibleItems = items.filter((item) => !item.isPrivate || item.createdByUserId === userId);
    return { list, items: visibleItems, matchedMemories: [] as (typeof schema.savedMemories.$inferSelect)[], sharedNote };
  }

  /**
   * SHARE-001 "edit/manage rights enforced" — previously owner-only with no way for a grantee to ever
   * update a list at all. A grant of "edit" or "manage" now also qualifies (this is exactly the kind of
   * "modify the resource's own fields" edit's spec definition covers); household members are unaffected —
   * this endpoint was never opened up to plain household membership and still isn't, only ownership vs.
   * grant changed.
   */
  async updateList(listId: string, userId: string, dto: UpdateListDto): Promise<void> {
    const list = await this.assertListAccess(listId, userId);
    if (list.ownerUserId !== userId && !(await this.sharing.hasGrantAtLeast("list", listId, userId, "edit"))) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the list owner or someone with edit access can edit it." });
    }
    const updates: Partial<typeof schema.lists.$inferInsert> = { updatedAt: new Date() };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.archived !== undefined) updates.archivedAt = dto.archived ? new Date() : null;
    if (dto.smartListQuery !== undefined) updates.smartListQuery = dto.smartListQuery;
    await this.db.update(schema.lists).set(updates).where(eq(schema.lists.id, listId));
  }

  /** SHARE-001 "manage = edit + delete" — deleting the list itself needs "manage", not just "edit" (edit
   * only covers the resource's own fields/items, per the spec's own right definitions). */
  async deleteList(listId: string, userId: string): Promise<void> {
    const list = await this.assertListAccess(listId, userId);
    if (list.ownerUserId !== userId && !(await this.sharing.hasGrantAtLeast("list", listId, userId, "manage"))) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the list owner or someone with manage access can delete it." });
    }
    await this.db.delete(schema.lists).where(eq(schema.lists.id, listId));
  }

  /**
   * SHARE-001 enforcement — adding an item is collaborative for household members exactly as before
   * (unaffected: `isOwnerOrHousehold` covers that path unchanged), but a grant-only accessor previously
   * could add items with a "view"-only grant (assertListAccess only ever checked whether ANY active grant
   * existed, never its right) — the exact "view grant can still write" gap this pass closes. Now requires
   * at least "edit".
   */
  async addItem(listId: string, userId: string, dto: CreateSavedItemDto) {
    const list = await this.assertListAccess(listId, userId);
    if (!(await this.isOwnerOrHousehold(list, userId)) && !(await this.sharing.hasGrantAtLeast("list", listId, userId, "edit"))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You need edit access to add items to this list." });
    }
    if (dto.assignedToUserId && dto.assignedToUserId !== userId) {
      if (!list.householdId) throw new ForbiddenException({ code: "HOUSEHOLD_REQUIRED", message: "Assigning an item to someone else requires a household list." });
      const assigneeIsMember = await this.households.isActiveMember(list.householdId, dto.assignedToUserId);
      if (!assigneeIsMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "That person isn't an active member of this household." });
    }
    const id = generateId("savedItem");
    await this.db.insert(schema.savedItems).values({
      id,
      listId,
      createdByUserId: userId,
      label: dto.label,
      assignedToUserId: dto.assignedToUserId ?? null,
      linkedResourceType: dto.linkedResourceType ?? null,
      linkedResourceId: dto.linkedResourceId ?? null,
      isPrivate: dto.isPrivate ?? false,
    });
    return { id };
  }

  private async ownedItem(itemId: string, userId: string) {
    const [item] = await this.db.select().from(schema.savedItems).where(eq(schema.savedItems.id, itemId)).limit(1);
    if (!item) throw new NotFoundException({ code: "ITEM_NOT_FOUND", message: "List item not found." });
    const list = await this.assertListAccess(item.listId, userId);
    if (item.isPrivate && item.createdByUserId !== userId) {
      throw new NotFoundException({ code: "ITEM_NOT_FOUND", message: "List item not found." });
    }
    return { item, list };
  }

  /** Anyone with access to the list can check/uncheck an item (a shared grocery list is collaborative by
   * nature — spec: "items can be assigned, checked"), but only the list owner, whoever added the item, or
   * an "edit"-or-above grantee can rename it, re-privatize it, or reassign it. */
  async updateItem(itemId: string, userId: string, dto: UpdateSavedItemDto): Promise<void> {
    const { item, list } = await this.ownedItem(itemId, userId);
    const canEditFully = list.ownerUserId === userId || item.createdByUserId === userId || (await this.sharing.hasGrantAtLeast("list", list.id, userId, "edit"));
    const updates: Partial<typeof schema.savedItems.$inferInsert> = { updatedAt: new Date() };
    if (dto.checked !== undefined) {
      updates.checked = dto.checked;
      updates.checkedAt = dto.checked ? new Date() : null;
      updates.checkedByUserId = dto.checked ? userId : null;
    }
    if (canEditFully) {
      if (dto.label !== undefined) updates.label = dto.label;
      if (dto.isPrivate !== undefined) updates.isPrivate = dto.isPrivate;
      if (dto.assignedToUserId !== undefined) updates.assignedToUserId = dto.assignedToUserId;
    }
    await this.db.update(schema.savedItems).set(updates).where(eq(schema.savedItems.id, itemId));
  }

  /** SHARE-001 — deleting an item is "modifying the resource's own items", which the spec's "edit" right
   * definition explicitly covers (only deleting the LIST ITSELF, or re-sharing it, needs "manage"). */
  async deleteItem(itemId: string, userId: string): Promise<void> {
    const { item, list } = await this.ownedItem(itemId, userId);
    if (list.ownerUserId !== userId && item.createdByUserId !== userId && !(await this.sharing.hasGrantAtLeast("list", list.id, userId, "edit"))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this item." });
    }
    await this.db.delete(schema.savedItems).where(eq(schema.savedItems.id, itemId));
  }

  // --- Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) --------------------------------------------
  // Same shape as DocumentsService's grant/share-link endpoints — see SharingService's own doc comment
  // for the split of responsibility (ownership checks and any resource-specific gate live here; the
  // grant/link mechanics themselves live in SharingService). Lists have no sensitivity tier, so unlike
  // documents/properties/vehicles there's no gate on createShareLink beyond ownership.

  async createResourceGrant(listId: string, requestingUserId: string, granteeEmail: string, expiresInDays?: number, right: ResourceGrantRight = "view", message?: string): Promise<{ id: string }> {
    await this.assertOwnedOrManagedListForSharing(listId, requestingUserId);
    return this.sharing.createResourceGrant("list", listId, requestingUserId, granteeEmail, expiresInDays, right, message);
  }

  /** SHARE-001 "preview exactly what recipient will see" — reuses publicShareContent (the same redacted,
   * read-only content a public link's actual recipient gets), gated the same as the rest of this section,
   * so the owner/manager can see it before ever creating a grant or link. */
  async sharePreview(listId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedListForSharing(listId, requestingUserId);
    return this.publicShareContent(listId);
  }

  async listResourceGrants(listId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedListForSharing(listId, requestingUserId);
    return this.sharing.listResourceGrants("list", listId);
  }

  async revokeResourceGrant(grantId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "list") return false;
      return (await this.sharing.hasGrantAtLeast("list", resourceId, requestingUserId, "manage")) || (await this.isOwnedBy(resourceId, requestingUserId));
    });
  }

  async createShareLink(listId: string, requestingUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    await this.assertOwnedOrManagedListForSharing(listId, requestingUserId);
    return this.sharing.createShareLink("list", listId, requestingUserId, dto);
  }

  async listShareLinks(listId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedListForSharing(listId, requestingUserId);
    return this.sharing.listShareLinks("list", listId);
  }

  async revokeShareLink(linkId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeShareLink(linkId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "list") return false;
      return (await this.sharing.hasGrantAtLeast("list", resourceId, requestingUserId, "manage")) || (await this.isOwnedBy(resourceId, requestingUserId));
    });
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAccessEvents(listId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedListForSharing(listId, requestingUserId);
    return this.sharing.listAccessEvents("list", listId);
  }

  /** True when `userId` is the list's owner — a plain lookup used by revokeResourceGrant/revokeShareLink's
   * authorization callback above (which only has a resourceId, not the caller's own already-loaded row). */
  private async isOwnedBy(listId: string, userId: string): Promise<boolean> {
    const [list] = await this.db.select({ ownerUserId: schema.lists.ownerUserId }).from(schema.lists).where(eq(schema.lists.id, listId)).limit(1);
    return list?.ownerUserId === userId;
  }

  /** Public, unauthenticated redemption content for a list share link — dispatched from
   * PublicShareService once the token/passcode has already been validated (see
   * SharingService.resolveShareLink). Private items are excluded entirely: an anonymous share-link
   * visitor has no identity to check `createdByUserId` against, so "private when needed" degrades to
   * "never shown on a public link" rather than guessing who's viewing. */
  async publicShareContent(listId: string) {
    const [list] = await this.db.select().from(schema.lists).where(eq(schema.lists.id, listId)).limit(1);
    if (!list) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    const items = await this.db
      .select({ label: schema.savedItems.label, checked: schema.savedItems.checked })
      .from(schema.savedItems)
      .where(and(eq(schema.savedItems.listId, listId), eq(schema.savedItems.isPrivate, false)))
      .orderBy(asc(schema.savedItems.position), asc(schema.savedItems.createdAt));
    return { name: list.name, kind: list.kind, items };
  }
}
