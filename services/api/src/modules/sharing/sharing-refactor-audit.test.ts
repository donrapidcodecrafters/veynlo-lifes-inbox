import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ListsService } from "../lists/lists.service";
import { CommerceService } from "../commerce/commerce.service";
import { AssetsService } from "../assets/assets.service";
import { SharingService } from "./sharing.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { RecallMonitorService } from "../assets/recall-monitor.service";
import type { VinDecodeService } from "../assets/vin-decode.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MemoriesService } from "../memories/memories.service";

/**
 * Security audit of the generalized object-sharing refactor (Phase 2 §52.2 — see
 * docs/PHASE2_PENDING_CREDENTIALS.md's "Object sharing" entry and SharingService's own doc comment).
 *
 * Unlike lists.sharing.test.ts / commerce.sharing.test.ts / assets.sharing.test.ts (which stub out
 * HouseholdService entirely), this uses a REAL HouseholdService against real dev Postgres, because the
 * exact bug class this refactor is most at risk of reintroducing — a service's access-check helper
 * missing the plain-active-membership OR-branch, or not re-checking membership live — only shows up when
 * household membership is real and mutated mid-test (a member leaving). See the "systemic household
 * membership visibility bug" fixed earlier across Commerce/Schedule/Lists/Assets/Documents (each has its
 * own `ownerOrDelegatedHousehold`/`assertXAccess` OR-ing in `activeHouseholdIds`) — this test proves that
 * fix is still intact after generalizing sharing on top of it, for every resource type sharing now
 * supports (lists, purchases, properties, vehicles).
 *
 * Also covers what's genuinely new here: direct-grant revocation is immediately effective (no caching
 * layer to invalidate), a share link's passcode is actually checked (wrong passcode rejected, right one
 * accepted, expired/revoked links rejected), and a token minted for one resource type can never resolve
 * against another resource type's access-check/content path (SharingService.resolveShareLink returns the
 * resourceType precisely so callers dispatch on it rather than guessing).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
// This audit exercises access control, not recall monitoring — stubbed the same way noopMailer/noopCache
// are, rather than pulling in real Redis/BullMQ or a real outbound NHTSA/CPSC call.
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubVinDecode = {} as unknown as VinDecodeService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;
// This audit exercises List sharing, not smart lists (SAVE-003) — no fixture here sets smartListQuery, so
// ListsService never calls into this.
const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;

describe("Object sharing refactor — cross-cutting access-control audit", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let lists: ListsService;
  let commerce: CommerceService;
  let assets: AssetsService;

  let ownerA: string; // creates every resource below
  let memberC: string; // plain active household member, no delegation, no grant
  let memberD: string; // active member who then leaves mid-test
  let strangerB: string; // no relationship to the household or any resource at all
  let strangerBEmail: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    lists = new ListsService(db, households, sharing, stubMemories);
    commerce = new CommerceService(db, households, sharing);
    assets = new AssetsService(db, households, sharing, stubRecallMonitor, stubVinDecode, stubQueue);

    try {
      ownerA = generateId("user");
      memberC = generateId("user");
      memberD = generateId("user");
      strangerB = generateId("user");
      strangerBEmail = `audit-stranger-${strangerB}@example.com`;
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerA, email: `audit-owner-${ownerA}@example.com`, displayName: "Owner A" },
        { id: memberC, email: `audit-memberc-${memberC}@example.com`, displayName: "Member C" },
        { id: memberD, email: `audit-memberd-${memberD}@example.com`, displayName: "Member D" },
        { id: strangerB, email: strangerBEmail, displayName: "Stranger B" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Audit Household", billingOwnerUserId: ownerA });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerA, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberC, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberD, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping sharing-refactor audit tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerA));
      await db.delete(schema.users).where(eq(schema.users.id, memberC));
      await db.delete(schema.users).where(eq(schema.users.id, memberD));
      await db.delete(schema.users).where(eq(schema.users.id, strangerB));
    }
  });

  it("lists: stranger denied by id, plain household member sees it, a member who leaves immediately loses access, grant/revoke is immediate, and passcode links behave correctly", async () => {
    if (!dbAvailable) return;
    const { id: listId } = await lists.createList(ownerA, { name: "Audit list", kind: "custom", householdId });
    await lists.addItem(listId, ownerA, { label: "Item one" });

    // 1. Stranger denied direct-by-id.
    await expect(lists.listDetail(listId, strangerB)).rejects.toThrow();
    await expect(lists.createResourceGrant(listId, strangerB, strangerBEmail)).rejects.toThrow();

    // 4a. Plain active household member (no delegation, no grant) sees it via normal household visibility.
    const memberView = await lists.listDetail(listId, memberC);
    expect(memberView.list.id).toBe(listId);
    expect((await lists.listLists(memberC)).some((l) => l.id === listId)).toBe(true);

    // memberD also has access while an active member...
    await expect(lists.listDetail(listId, memberD)).resolves.toBeTruthy();
    // ...then leaves the household, and immediately loses access on the very next request.
    await households.leave(householdId, memberD);
    await expect(lists.listDetail(listId, memberD)).rejects.toThrow();
    expect((await lists.listLists(memberD)).some((l) => l.id === listId)).toBe(false);

    // 2. Direct grant to the stranger: denied before, allowed after, immediately revoked after.
    const { id: grantId } = await lists.createResourceGrant(listId, ownerA, strangerBEmail);
    await expect(lists.listDetail(listId, strangerB)).resolves.toBeTruthy();
    await lists.revokeResourceGrant(grantId, ownerA);
    await expect(lists.listDetail(listId, strangerB)).rejects.toThrow();

    // 3. Share link with passcode: wrong passcode rejected, right one works, revoked link rejected.
    const { id: linkId, token } = await lists.createShareLink(listId, ownerA, { passcode: "correct-horse-1" });
    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();
    await expect(sharing.resolveShareLink(token, "wrong-passcode")).rejects.toThrow();
    const resolved = await sharing.resolveShareLink(token, "correct-horse-1");
    expect(resolved.resourceType).toBe("list");
    expect(resolved.resourceId).toBe(listId);
    await lists.revokeShareLink(linkId, ownerA);
    await expect(sharing.resolveShareLink(token, "correct-horse-1")).rejects.toThrow();

    // Expired link: create one, then backdate its expiresAt directly (simulating time passing) and confirm
    // it's rejected exactly like an unknown token, not silently accepted.
    const { token: expToken } = await lists.createShareLink(listId, ownerA, {});
    const expTokenHash = createHash("sha256").update(expToken).digest("hex");
    await db.update(schema.shareLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.shareLinks.tokenHash, expTokenHash));
    await expect(sharing.resolveShareLink(expToken, undefined)).rejects.toThrow();

    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
  });

  it("purchases: same full matrix as lists — stranger denied, household member visibility, post-leave revocation, grant/revoke, passcode link", async () => {
    if (!dbAvailable) return;
    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId: ownerA,
      householdId,
      orderNumber: "AUDIT-001",
      purchaseDate,
      purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
      totalMinorUnits: 1_000,
      totalCurrency: "USD",
      state: "candidate",
      confidenceBand: "high",
    });

    expect(await commerce.purchaseDetail(purchaseId, strangerB)).toBeNull();

    const memberDetail = await commerce.purchaseDetail(purchaseId, memberC);
    expect(memberDetail?.purchase.id).toBe(purchaseId);
    expect((await commerce.purchases(memberC)).some((p) => p.id === purchaseId)).toBe(true);

    // memberD already left the household in the previous test (household membership is a real DB row
    // shared across this whole describe block) — confirm that's still honored here too.
    expect(await commerce.purchaseDetail(purchaseId, memberD)).toBeNull();

    const { id: grantId } = await commerce.createResourceGrant(purchaseId, ownerA, strangerBEmail);
    expect((await commerce.purchaseDetail(purchaseId, strangerB))?.purchase.id).toBe(purchaseId);
    await commerce.revokeResourceGrant(grantId, ownerA);
    expect(await commerce.purchaseDetail(purchaseId, strangerB)).toBeNull();

    const { id: linkId, token } = await commerce.createShareLink(purchaseId, ownerA, { passcode: "correct-horse-2" });
    await expect(sharing.resolveShareLink(token, "wrong-passcode")).rejects.toThrow();
    const resolved = await sharing.resolveShareLink(token, "correct-horse-2");
    expect(resolved.resourceType).toBe("purchase");
    await commerce.revokeShareLink(linkId, ownerA);
    await expect(sharing.resolveShareLink(token, "correct-horse-2")).rejects.toThrow();

    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  });

  it("properties: same full matrix, plus the highly_sensitive public-link gate", async () => {
    if (!dbAvailable) return;
    const { id: propertyId } = await assets.createProperty(ownerA, { label: "Audit house", propertyType: "home", householdId });

    await expect(assets.propertyDetail(propertyId, strangerB)).rejects.toThrow();

    await expect(assets.propertyDetail(propertyId, memberC)).resolves.toBeTruthy();
    expect((await assets.listProperties(memberC)).some((p) => p.id === propertyId)).toBe(true);

    // memberD already left the household — confirm post-leave denial here too, not just for lists.
    await expect(assets.propertyDetail(propertyId, memberD)).rejects.toThrow();
    expect((await assets.listProperties(memberD)).some((p) => p.id === propertyId)).toBe(false);

    const { id: grantId } = await assets.createPropertyGrant(propertyId, ownerA, strangerBEmail);
    await expect(assets.propertyDetail(propertyId, strangerB)).resolves.toBeTruthy();
    await assets.revokeResourceGrant(grantId, ownerA);
    await expect(assets.propertyDetail(propertyId, strangerB)).rejects.toThrow();

    const { id: linkId, token } = await assets.createPropertyShareLink(propertyId, ownerA, { passcode: "correct-horse-3" });
    await expect(sharing.resolveShareLink(token, "wrong-passcode")).rejects.toThrow();
    const resolved = await sharing.resolveShareLink(token, "correct-horse-3");
    expect(resolved.resourceType).toBe("property");
    await assets.revokeShareLink(linkId, ownerA);
    await expect(sharing.resolveShareLink(token, "correct-horse-3")).rejects.toThrow();

    // The sensitivity gate must actually block link CREATION for a highly_sensitive property.
    await db.update(schema.propertyProfiles).set({ sensitivity: "secret" }).where(eq(schema.propertyProfiles.id, propertyId));
    await expect(assets.createPropertyShareLink(propertyId, ownerA, {})).rejects.toThrow();
    // A direct grant is still allowed for secret-tier content (targets one named account, not the public).
    await expect(assets.createPropertyGrant(propertyId, ownerA, strangerBEmail)).resolves.toHaveProperty("id");

    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
  });

  it("vehicles: same full matrix as properties — this resource type has no dedicated sharing test yet", async () => {
    if (!dbAvailable) return;
    const { id: vehicleId } = await assets.createVehicle(ownerA, { label: "Audit car", vin: "1AUDITVIN000000", householdId });

    await expect(assets.vehicleDetail(vehicleId, strangerB)).rejects.toThrow();

    await expect(assets.vehicleDetail(vehicleId, memberC)).resolves.toBeTruthy();
    expect((await assets.listVehicles(memberC)).some((v) => v.id === vehicleId)).toBe(true);

    await expect(assets.vehicleDetail(vehicleId, memberD)).rejects.toThrow();
    expect((await assets.listVehicles(memberD)).some((v) => v.id === vehicleId)).toBe(false);

    const { id: grantId } = await assets.createVehicleGrant(vehicleId, ownerA, strangerBEmail);
    await expect(assets.vehicleDetail(vehicleId, strangerB)).resolves.toBeTruthy();
    await assets.revokeResourceGrant(grantId, ownerA);
    await expect(assets.vehicleDetail(vehicleId, strangerB)).rejects.toThrow();

    const { id: linkId, token } = await assets.createVehicleShareLink(vehicleId, ownerA, { passcode: "correct-horse-4" });
    await expect(sharing.resolveShareLink(token, "wrong-passcode")).rejects.toThrow();
    const resolved = await sharing.resolveShareLink(token, "correct-horse-4");
    expect(resolved.resourceType).toBe("vehicle");
    await assets.revokeShareLink(linkId, ownerA);
    await expect(sharing.resolveShareLink(token, "correct-horse-4")).rejects.toThrow();

    // Sensitivity gate applies to vehicles too — and the public redemption content must never include the VIN.
    await db.update(schema.vehicleProfiles).set({ sensitivity: "highly_sensitive" }).where(eq(schema.vehicleProfiles.id, vehicleId));
    await expect(assets.createVehicleShareLink(vehicleId, ownerA, {})).rejects.toThrow();
    await db.update(schema.vehicleProfiles).set({ sensitivity: "sensitive" }).where(eq(schema.vehicleProfiles.id, vehicleId));
    const { token: vToken } = await assets.createVehicleShareLink(vehicleId, ownerA, {});
    const { resourceId: vResourceId } = await sharing.resolveShareLink(vToken, undefined);
    const publicContent = await assets.publicVehicleContent(vResourceId);
    expect(publicContent).not.toHaveProperty("vin");
    expect(JSON.stringify(publicContent)).not.toContain("1AUDITVIN000000");

    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
  });

  it("cross-resource-type token confusion: a token minted for a list can never resolve against another resource type's content/access path", async () => {
    if (!dbAvailable) return;
    const { id: listId } = await lists.createList(ownerA, { name: "Confusion-check list", kind: "custom" });
    const { token } = await lists.createShareLink(listId, ownerA, {});

    const { resourceType, resourceId } = await sharing.resolveShareLink(token, undefined);
    expect(resourceType).toBe("list");
    expect(resourceId).toBe(listId);

    // Feeding the resolved list id into the OTHER resource types' public-content methods must find
    // nothing — ids are namespaced per resource kind (see @veynlo/core generateId), so this also proves
    // there's no shared-id collision path even if a resourceType filter were ever dropped somewhere.
    await expect(commerce.publicShareContent(resourceId)).rejects.toThrow();
    await expect(assets.publicPropertyContent(resourceId)).rejects.toThrow();
    await expect(assets.publicVehicleContent(resourceId)).rejects.toThrow();

    // And hasActiveGrant/resolveShareLink themselves are resourceType-scoped: a grant recorded for
    // "list"/listId must not be visible when queried as "purchase"/listId (same id, wrong type).
    const { id: grantId } = await lists.createResourceGrant(listId, ownerA, strangerBEmail);
    expect(await sharing.hasActiveGrant("list", listId, strangerB)).toBe(true);
    expect(await sharing.hasActiveGrant("purchase", listId, strangerB)).toBe(false);
    expect(await sharing.hasActiveGrant("property", listId, strangerB)).toBe(false);
    expect(await sharing.hasActiveGrant("vehicle", listId, strangerB)).toBe(false);
    await lists.revokeResourceGrant(grantId, ownerA);

    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
  });

  /**
   * SHARE-001 gap found during the requirements re-audit: the spec calls for a direct grant to support
   * "Set view/edit/manage, expiration and optional message," but `CreateResourceGrantDtoSchema` only ever
   * accepted `granteeEmail` — `resourceGrants.expiresAt` (and its read-side enforcement in
   * `hasActiveGrant`/`grantedResourceIds`, both already gating on `or(isNull(expiresAt), gt(expiresAt,
   * now))`) existed and was already exercised by share-LINK expiry, but no direct grant could ever be
   * created with one — every direct grant was permanent regardless of what the owner intended. Fixed by
   * threading an optional `expiresInDays` through `CreateResourceGrantDtoSchema` ->
   * `SharingService.createResourceGrant` -> every resource's own `create*Grant` wrapper. This proves the
   * fix end to end on a real resource (purchases): access granted immediately, still granted while
   * unexpired, denied once the stored `expiresAt` is in the past — same backdating technique
   * `lists.sharing.test.ts`'s share-link expiry test already uses for share links.
   */
  it("purchases: a direct grant created with expiresInDays actually expires — access denied once expiresAt has passed", async () => {
    if (!dbAvailable) return;
    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId: ownerA,
      orderNumber: "AUDIT-EXPIRY-001",
      purchaseDate,
      purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
      totalMinorUnits: 500,
      totalCurrency: "USD",
      state: "candidate",
      confidenceBand: "high",
    });

    const { id: grantId } = await commerce.createResourceGrant(purchaseId, ownerA, strangerBEmail, 7);
    const [row] = await db.select({ expiresAt: schema.resourceGrants.expiresAt }).from(schema.resourceGrants).where(eq(schema.resourceGrants.id, grantId)).limit(1);
    expect(row?.expiresAt).not.toBeNull();

    // Still within the window: access granted.
    expect((await commerce.purchaseDetail(purchaseId, strangerB))?.purchase.id).toBe(purchaseId);

    // Backdate expiresAt (simulating the 7 days having passed) — access must be denied immediately, not
    // just after some separate cleanup/cron step (there is none in this codebase — enforcement is always
    // live, read-time).
    await db.update(schema.resourceGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.resourceGrants.id, grantId));
    expect(await commerce.purchaseDetail(purchaseId, strangerB)).toBeNull();

    // A grant created with no expiresInDays at all is still permanent (unchanged prior behavior).
    const { id: permanentGrantId } = await commerce.createResourceGrant(purchaseId, ownerA, strangerBEmail);
    const [permanentRow] = await db.select({ expiresAt: schema.resourceGrants.expiresAt }).from(schema.resourceGrants).where(eq(schema.resourceGrants.id, permanentGrantId)).limit(1);
    expect(permanentRow?.expiresAt).toBeNull();

    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  });
});
