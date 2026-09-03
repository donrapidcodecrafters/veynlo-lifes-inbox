import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { MemoriesService } from "./memories.service";
import { ResurfacingService } from "./resurfacing.service";
import { SharingService } from "../sharing/sharing.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { MailerService } from "../notifications/mailer.service";
import type { Cache } from "../../cache/cache.interface";
import type { DocumentsService } from "../documents/documents.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * §29.1 "Saved Memory, Lists & Knowledge" (SAVE-001..007). Real-DB test covering the things most likely to
 * be silently wrong: private-by-default access (no household-implied visibility, unlike Lists), duplicate-
 * save dedup, the classification pipeline (via FakeModelProvider, same pattern as ingestion's own tests),
 * automatic gift-idea birthday resurfacing-rule creation, and smart-list criteria evaluation.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubDocuments = { documentDetail: async () => ({ version: null }) } as unknown as DocumentsService;

describe("MemoriesService", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let ownerUserId: string;
  let strangerUserId: string;
  let granteeUserId: string;
  let granteeEmail: string;
  let householdId: string;
  let dependentId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    try {
      ownerUserId = generateId("user");
      strangerUserId = generateId("user");
      granteeUserId = generateId("user");
      granteeEmail = `memories-grantee-${granteeUserId}@example.com`;
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `memories-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: strangerUserId, email: `memories-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
        { id: granteeUserId, email: granteeEmail, displayName: "Grantee" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values({
        id: generateId("membership"),
        householdId,
        userId: ownerUserId,
        role: "household_owner",
        status: "active",
        joinedAt: new Date(),
      });
      dependentId = generateId("dependentProfile");
      await db.insert(schema.dependentProfiles).values({
        id: dependentId,
        householdId,
        displayName: "Dad",
        birthDate: "1970-06-15",
        guardianUserIds: [ownerUserId],
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping MemoriesService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, granteeUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  function makeService(ai: FakeModelProvider) {
    const queue = { enqueueMemoryClassification: async () => {} } as unknown as QueueProducer;
    return new MemoriesService(db, ai, queue, stubDocuments, households, sharing);
  }

  it("SAVE-001: saves immediately, private by default, and dedups a repeat save of the same URL", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false; // classification not required before save succeeds (SAVE-002)
    const memories = makeService(ai);

    const first = await memories.create(ownerUserId, { sourceKind: "link", sourceUrl: "https://example.com/denver-restaurant" });
    expect(first.duplicate).toBe(false);

    const second = await memories.create(ownerUserId, { sourceKind: "link", sourceUrl: "https://example.com/denver-restaurant" });
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);

    // Private by default — a stranger with no grant can't see it at all, unlike Lists' household-implied
    // visibility default.
    await expect(memories.detail(first.id, strangerUserId)).rejects.toThrow();
    const owned = await memories.detail(first.id, ownerUserId);
    expect(owned.ownerUserId).toBe(ownerUserId);
    // No AI configured — classification is honestly "skipped", never stuck at "pending" forever.
    expect(owned.classificationState).toBe("skipped");

    await memories.delete(first.id, ownerUserId);
  });

  it("SAVE-002/004: classifies a gift-idea save and auto-creates a birthday resurfacing rule for a matching dependent", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const memories = makeService(ai);

    const { id } = await memories.create(ownerUserId, { sourceKind: "product", rawText: "A nice watch for Dad, $120" });
    ai.enqueue(
      "memory_classification_v1",
      fakeExtraction({
        category: "gift_idea" as const,
        confidence: 0.9,
        suggestedTitle: "Watch for Dad",
        relatedPersonLabel: "Dad",
        priceMinorUnits: 12000,
        currency: "USD",
        locationLabel: null,
        confidenceNotes: "stated explicitly",
      }),
    );
    await memories.processClassification(id);

    const detail = await memories.detail(id, ownerUserId);
    expect(detail.category).toBe("gift_idea");
    expect(detail.classificationState).toBe("classified");
    expect(detail.title).toBe("Watch for Dad"); // no user-provided title, so the suggestion fills it in
    expect(detail.relatedPersonLabel).toBe("Dad");

    const rules = await memories.listResurfacingRules(id, ownerUserId);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.triggerType).toBe("person_birthday");
    expect((rules[0]?.triggerConfig as { dependentProfileId?: string }).dependentProfileId).toBe(dependentId);

    await memories.delete(id, ownerUserId);
  });

  it("SAVE-002: never overwrites a user-provided title with the classifier's suggestion", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const memories = makeService(ai);

    const { id } = await memories.create(ownerUserId, { sourceKind: "note", rawText: "some article text", title: "My own title" });
    ai.enqueue(
      "memory_classification_v1",
      fakeExtraction({
        category: "article" as const,
        confidence: 0.7,
        suggestedTitle: "Classifier's Title",
        relatedPersonLabel: null,
        priceMinorUnits: null,
        currency: null,
        locationLabel: null,
        confidenceNotes: "",
      }),
    );
    await memories.processClassification(id);
    const detail = await memories.detail(id, ownerUserId);
    expect(detail.title).toBe("My own title");
    expect(detail.category).toBe("article");

    await memories.delete(id, ownerUserId);
  });

  it("SAVE-001 object sharing: a grant gives real access; search and category filtering only see the owner's own private saves", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false;
    const memories = makeService(ai);

    const { id } = await memories.create(ownerUserId, {
      sourceKind: "note",
      rawText: "Best pizza place downtown",
      title: "Pizza spot",
      userNotes: "This is where we had our first date — secret from everyone",
    });
    await expect(memories.detail(id, granteeUserId)).rejects.toThrow();

    await memories.createResourceGrant(id, ownerUserId, granteeEmail);
    const granteeView = await memories.detail(id, granteeUserId);
    expect(granteeView.id).toBe(id);
    // SAVE-006 "notes... can stay private when base item is shared" — a grant shares the save, not the
    // owner's private annotation about it.
    expect(granteeView.userNotes).toBeNull();
    const ownerView = await memories.detail(id, ownerUserId);
    expect(ownerView.userNotes).toContain("secret from everyone");

    const found = await memories.search(ownerUserId, "pizza");
    expect(found.some((m) => m.id === id)).toBe(true);
    const strangerSearch = await memories.search(strangerUserId, "pizza");
    expect(strangerSearch.some((m) => m.id === id)).toBe(false);
    // The grantee's own search results must never carry the private note's content either — every row
    // MemoriesService.search returns to a non-owner is built from the same redacted candidate, not the raw
    // DB row.
    const granteeSearchResults = await memories.search(granteeUserId, "pizza");
    const granteeSearchHit = granteeSearchResults.find((m) => m.id === id);
    expect(granteeSearchHit?.userNotes).toBeNull();

    const publicContent = await memories.publicShareContent(id);
    expect(publicContent).not.toHaveProperty("userNotes");

    await memories.delete(id, ownerUserId);
  });

  it("SAVE-003: smart list criteria evaluation matches category/person/price and stays scoped to one owner's own saves", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false;
    const memories = makeService(ai);

    const { id: cheapGift } = await memories.create(ownerUserId, { sourceKind: "product", rawText: "cheap gift" });
    await memories.update(cheapGift, ownerUserId, { category: "gift_idea", relatedPersonLabel: "Dad" });
    const { id: expensiveGift } = await memories.create(ownerUserId, { sourceKind: "product", rawText: "expensive gift idea" });
    await memories.update(expensiveGift, ownerUserId, { category: "gift_idea", relatedPersonLabel: "Mom" });

    const results = await memories.evaluateSmartQuery(ownerUserId, { category: "gift_idea", personLabelContains: "Dad" });
    expect(results.map((r) => r.id)).toContain(cheapGift);
    expect(results.map((r) => r.id)).not.toContain(expensiveGift);

    const strangerResults = await memories.evaluateSmartQuery(strangerUserId, { category: "gift_idea" });
    expect(strangerResults).toHaveLength(0);

    await memories.delete(cheapGift, ownerUserId);
    await memories.delete(expensiveGift, ownerUserId);
  });

  it("SAVE-007: pinning, archiving, never-resurface, and mark-not-useful are all owner-editable", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false;
    const memories = makeService(ai);

    const { id } = await memories.create(ownerUserId, { sourceKind: "note", rawText: "something to remember" });
    await memories.update(id, ownerUserId, { pinned: true, neverResurface: true, markNotUseful: true });
    const [row] = await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.id, id));
    expect(row?.pinned).toBe(true);
    expect(row?.neverResurface).toBe(true);
    expect(row?.notUsefulAt).not.toBeNull();

    await memories.update(id, ownerUserId, { archived: true });
    const archivedList = await memories.list(ownerUserId, { archived: true });
    expect(archivedList.some((m) => m.id === id)).toBe(true);
    const activeList = await memories.list(ownerUserId, { archived: false });
    expect(activeList.some((m) => m.id === id)).toBe(false);

    // Editing is owner-only, even with a grant (SharingService grants are always view-only).
    await memories.createResourceGrant(id, ownerUserId, granteeEmail);
    await expect(memories.update(id, granteeUserId, { pinned: false })).rejects.toThrow();

    await memories.delete(id, ownerUserId);
  });

  it("SAVE-006: tags, rating, and highlights round-trip and stay private to a non-owner grant recipient", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false;
    const memories = makeService(ai);

    const { id } = await memories.create(ownerUserId, { sourceKind: "link", sourceUrl: "https://example.com/great-article", title: "Great article" });
    await memories.update(id, ownerUserId, {
      tags: ["recipe", "weeknight"],
      rating: 4,
      highlights: ["\"The secret is browning the butter first.\"", "\"Serves four generously.\""],
    });

    const ownerView = await memories.detail(id, ownerUserId);
    expect(ownerView.tags).toEqual(["recipe", "weeknight"]);
    expect(ownerView.rating).toBe(4);
    expect(ownerView.highlights).toHaveLength(2);
    expect(ownerView.highlights).toContain("\"Serves four generously.\"");

    // Round-trips through a plain re-fetch too, not just the in-memory return value of update().
    const [row] = await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.id, id));
    expect(row?.tags).toEqual(["recipe", "weeknight"]);
    expect(row?.rating).toBe(4);

    // Replacing the whole list (not appending) is the documented "whole-value PUT" shape.
    await memories.update(id, ownerUserId, { tags: ["recipe"] });
    const afterReplace = await memories.detail(id, ownerUserId);
    expect(afterReplace.tags).toEqual(["recipe"]);

    // SAVE-006 "stays private when base item is shared" — same redaction discipline as userNotes: a named
    // grant recipient (an adversarial "I have real read access to this resource" case, not just a stranger
    // with none) must never see tags/rating/highlights, in the detail view, in list(), or in search().
    await memories.createResourceGrant(id, ownerUserId, granteeEmail);
    const granteeView = await memories.detail(id, granteeUserId);
    expect(granteeView.tags).toEqual([]);
    expect(granteeView.rating).toBeNull();
    expect(granteeView.highlights).toEqual([]);

    const granteeList = await memories.list(granteeUserId);
    const granteeListRow = granteeList.find((m) => m.id === id);
    expect(granteeListRow?.tags).toEqual([]);
    expect(granteeListRow?.rating).toBeNull();

    const granteeSearch = await memories.search(granteeUserId, "great article");
    const granteeSearchRow = granteeSearch.find((m) => m.id === id);
    expect(granteeSearchRow?.tags).toEqual([]);
    expect(granteeSearchRow?.highlights).toEqual([]);

    // The public, unauthenticated share-link payload never even selects these columns.
    const publicContent = await memories.publicShareContent(id);
    expect(publicContent).not.toHaveProperty("tags");
    expect(publicContent).not.toHaveProperty("rating");
    expect(publicContent).not.toHaveProperty("highlights");

    await memories.delete(id, ownerUserId);
  });

  it("SAVE-007: autoArchiveAt set through update() (the UI's picker) is actually picked up by the existing background scan", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false;
    const memories = makeService(ai);
    const resurfacing = new ResurfacingService(db);

    const { id } = await memories.create(ownerUserId, { sourceKind: "note", rawText: "Recipe to try before it's out of season" });
    // Simulates the web/mobile "Archive automatically after..." picker: a future ISO date computed
    // client-side (e.g. "in 30 days") sent through the exact same UpdateMemoryDto field the backend
    // already had. Set 60ms in the past here so the very next scan tick treats it as due.
    const dueAt = new Date(Date.now() - 60_000).toISOString();
    await memories.update(id, ownerUserId, { autoArchiveAtIso: dueAt });

    const beforeScan = await memories.detail(id, ownerUserId);
    expect(beforeScan.autoArchiveAt).not.toBeNull();
    expect(beforeScan.archivedAt).toBeNull();

    await resurfacing.scanAndFileResurfacing();

    const afterScan = await memories.detail(id, ownerUserId);
    expect(afterScan.archivedAt).not.toBeNull();

    await memories.delete(id, ownerUserId);
  });
});
