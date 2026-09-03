import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { DocumentsService } from "./documents.service";
import { isValidProcessingStateTransition } from "./processing-state";
import { SharingService } from "../sharing/sharing.service";
import type { ObjectStorage } from "./object-storage.interface";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MalwareScannerService } from "./malware-scanner.service";
import type { HouseholdService } from "../household/household.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";

/**
 * §40.3 "Representative state machines" (Document row): "uploaded → malware scan → OCR/parser →
 * classified → extracted → linked → verified / superseded / archived / deleted." Real DB integration
 * tests, same shape as documents.delete.test.ts/documents.content-hash.test.ts, covering the five
 * processingState values this round adds real transitions for: linked, verified, superseded, archived,
 * deleted — plus the transition-validity guard (`isValidProcessingStateTransition`) that keeps a client
 * from forcing a document into a nonsensical state.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubStorage = {
  putObject: async () => {},
  getObject: async () => Buffer.alloc(0),
  signedGetUrl: async (blobRef: string) => `https://example.com/signed/${blobRef}`,
} as unknown as ObjectStorage;
const stubAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const allowingEntitlements = { assertStorageQuota: async () => {} } as unknown as EntitlementsService;

describe("DocumentsService processing-state machine (§40.3)", () => {
  let db: Database;
  let documents: DocumentsService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;
  const createdDocumentIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    documents = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, stubHouseholds, allowingEntitlements, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `doc-state-test-${ownerUserId}@example.com`, displayName: "State Test" },
        { id: otherUserId, email: `doc-state-test-${otherUserId}@example.com`, displayName: "State Test Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DocumentsService processing-state tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (createdDocumentIds.length > 0) {
        for (const id of createdDocumentIds) {
          await db.delete(schema.documents).where(eq(schema.documents.id, id));
        }
      }
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("uploading a document with content identical to an existing live document supersedes the old one automatically", async () => {
    if (!dbAvailable) return;
    const body = Buffer.from(`identical receipt body ${generateId("document")}`, "utf8");

    const { documentId: originalId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Receipt v1",
      documentType: "receipt",
      mimeType: "text/plain",
      buffer: body,
    });
    createdDocumentIds.push(originalId);

    const [originalBefore] = await db.select().from(schema.documents).where(eq(schema.documents.id, originalId));
    expect(originalBefore?.processingState).toBe("extracted");
    expect(originalBefore?.supersededByDocumentId).toBeNull();

    // Re-uploading the exact same bytes (a re-scan, a duplicate email attachment) — a maximally confident
    // "same document" signal, so this fires without any extra user confirmation.
    const { documentId: reuploadId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Receipt v1 (rescanned)",
      documentType: "receipt",
      mimeType: "text/plain",
      buffer: body,
    });
    createdDocumentIds.push(reuploadId);

    const [originalAfter] = await db.select().from(schema.documents).where(eq(schema.documents.id, originalId));
    expect(originalAfter?.processingState).toBe("superseded");
    expect(originalAfter?.supersededByDocumentId).toBe(reuploadId);

    const [reupload] = await db.select().from(schema.documents).where(eq(schema.documents.id, reuploadId));
    expect(reupload?.processingState).toBe("extracted"); // the new document itself just goes through the ordinary pipeline
    expect(reupload?.supersededByDocumentId).toBeNull();

    // A superseded document drops out of the default vault view but is still directly reachable.
    const activeList = await documents.list(ownerUserId);
    expect(activeList.map((d) => d.id)).not.toContain(originalId);
    expect(activeList.map((d) => d.id)).toContain(reuploadId);

    const supersededList = await documents.list(ownerUserId, "superseded");
    expect(supersededList.map((d) => d.id)).toContain(originalId);

    const detail = await documents.documentDetail(reuploadId, ownerUserId);
    expect(detail.replaces.map((r) => r.id)).toContain(originalId);
  });

  it("markSuperseded is the explicit path for a replacement whose content differs, and is precision-gated", async () => {
    if (!dbAvailable) return;
    const { documentId: oldLeaseId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Lease v1",
      documentType: "contract",
      mimeType: "text/plain",
      buffer: Buffer.from(`lease original ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(oldLeaseId);
    const { documentId: amendedLeaseId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Lease v2 (amended)",
      documentType: "contract",
      mimeType: "text/plain",
      buffer: Buffer.from(`lease amended ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(amendedLeaseId);
    const { documentId: unrelatedId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Unrelated warranty",
      documentType: "warranty",
      mimeType: "text/plain",
      buffer: Buffer.from(`unrelated warranty ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(unrelatedId);

    // Different bytes, so the automatic content-hash path in upload() never fires — content-hash-different
    // "same document, corrected" cases are exactly what this explicit action is for.
    const [beforeAmend] = await db.select({ processingState: schema.documents.processingState }).from(schema.documents).where(eq(schema.documents.id, oldLeaseId));
    expect(beforeAmend?.processingState).toBe("extracted");

    // Guard: two documents with no shared documentType/linkedEntityIds/sourceEventId signal are rejected —
    // never guess a replacement relationship from ids alone.
    await expect(documents.markSuperseded(oldLeaseId, ownerUserId, unrelatedId)).rejects.toThrow();

    // A non-owner can't supersede someone else's documents.
    await expect(documents.markSuperseded(oldLeaseId, otherUserId, amendedLeaseId)).rejects.toThrow();

    // Same documentType ("contract") is a real relatedness signal — the explicit, confirmed action succeeds.
    await documents.markSuperseded(oldLeaseId, ownerUserId, amendedLeaseId);

    const [oldAfter] = await db.select().from(schema.documents).where(eq(schema.documents.id, oldLeaseId));
    expect(oldAfter?.processingState).toBe("superseded");
    expect(oldAfter?.supersededByDocumentId).toBe(amendedLeaseId);

    // A document can't replace itself.
    await expect(documents.markSuperseded(amendedLeaseId, ownerUserId, amendedLeaseId)).rejects.toThrow();

    // Found live via manual QA: the web UI used to resolve "Replaced by: <title>" by cross-referencing
    // the CURRENT page's already-filtered `data` array, so on the "Superseded"-only tab (which excludes
    // the still-active replacement document) it silently fell back to a raw document id. `list()` must
    // resolve the title itself, against the full document set, regardless of which filter is active.
    const supersededList = await documents.list(ownerUserId, "superseded");
    const oldLeaseRow = supersededList.find((d) => d.id === oldLeaseId);
    expect(oldLeaseRow?.supersededByDocumentId).toBe(amendedLeaseId);
    expect(oldLeaseRow?.supersededByTitle).toBe("Lease v2 (amended)");
    // The replacement itself is active, not superseded, so it's correctly absent from this filtered list —
    // proving the title above genuinely came from a server-side lookup, not a lucky same-page match.
    expect(supersededList.find((d) => d.id === amendedLeaseId)).toBeUndefined();

    // A document with no supersededByDocumentId reports a null title, not undefined/a stale value.
    const activeList = await documents.list(ownerUserId, "active");
    const amendedRow = activeList.find((d) => d.id === amendedLeaseId);
    expect(amendedRow?.supersededByDocumentId).toBeNull();
    expect(amendedRow?.supersededByTitle).toBeNull();
  });

  it("verify() sets processingState to verified and stamps verifiedAt; idempotent; refuses an unprocessed document", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Statement to confirm",
      documentType: "statement",
      mimeType: "text/plain",
      buffer: Buffer.from(`statement ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(documentId);

    await expect(documents.verify(documentId, otherUserId)).rejects.toThrow(); // non-owner

    await documents.verify(documentId, ownerUserId);
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(row?.processingState).toBe("verified");
    expect(row?.verifiedAt).not.toBeNull();

    // Idempotent — verifying an already-verified document is a no-op, not an error.
    await expect(documents.verify(documentId, ownerUserId)).resolves.not.toThrow();

    // Freshly-uploaded ("uploaded", never even classified) has nothing to confirm yet.
    const rawDocumentId = generateId("document");
    await db.insert(schema.documents).values({ id: rawDocumentId, ownerUserId, documentType: "other", title: "Still uploading", tags: [] });
    createdDocumentIds.push(rawDocumentId);
    await expect(documents.verify(rawDocumentId, ownerUserId)).rejects.toThrow();
  });

  it("archive() excludes a document from the default list() but keeps it reachable via the archived filter; unarchive() restores its exact prior stage", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "To be archived",
      documentType: "manual",
      mimeType: "text/plain",
      buffer: Buffer.from(`manual ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(documentId);
    await documents.verify(documentId, ownerUserId); // reach "verified" so we can prove unarchive restores it exactly, not just any pipeline stage

    await expect(documents.archive(documentId, otherUserId)).rejects.toThrow(); // non-owner
    await documents.archive(documentId, ownerUserId);

    const [archived] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(archived?.processingState).toBe("archived");
    expect(archived?.previousProcessingState).toBe("verified");

    const activeList = await documents.list(ownerUserId);
    expect(activeList.map((d) => d.id)).not.toContain(documentId);

    const archivedList = await documents.list(ownerUserId, "archived");
    expect(archivedList.map((d) => d.id)).toContain(documentId);

    const allList = await documents.list(ownerUserId, "all");
    expect(allList.map((d) => d.id)).toContain(documentId);

    // Archiving twice is a harmless no-op.
    await expect(documents.archive(documentId, ownerUserId)).resolves.not.toThrow();

    await documents.unarchive(documentId, ownerUserId);
    const [restored] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(restored?.processingState).toBe("verified"); // restored to the exact stage it was archived from, not just any pipeline stage
    expect(restored?.previousProcessingState).toBeNull();

    const activeListAfterRestore = await documents.list(ownerUserId);
    expect(activeListAfterRestore.map((d) => d.id)).toContain(documentId);

    // unarchive() on a non-archived document is rejected.
    await expect(documents.unarchive(documentId, ownerUserId)).rejects.toThrow();
  });

  it("linkToEntity() advances processingState to linked exactly once, and never regresses verified back down", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Receipt to link",
      documentType: "receipt",
      mimeType: "text/plain",
      buffer: Buffer.from(`link me ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(documentId);

    const purchaseId = generateId("purchase");
    await documents.linkToEntity(documentId, ownerUserId, purchaseId);
    const [linked] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(linked?.processingState).toBe("linked");
    expect(linked?.linkedEntityIds).toContain(purchaseId);

    // Re-linking the same entity is idempotent — no duplicate ids, no error.
    await documents.linkToEntity(documentId, ownerUserId, purchaseId);
    const [relinkedRow] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(relinkedRow?.linkedEntityIds.filter((id) => id === purchaseId)).toHaveLength(1);

    // Verifying moves the document forward past "linked".
    await documents.verify(documentId, ownerUserId);

    // Linking a second entity on an already-verified document must not regress processingState back to "linked".
    const secondEntityId = generateId("purchase");
    await documents.linkToEntity(documentId, ownerUserId, secondEntityId);
    const [afterSecondLink] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(afterSecondLink?.processingState).toBe("verified");
    expect(afterSecondLink?.linkedEntityIds).toContain(secondEntityId);
  });

  it("delete() writes processingState: 'deleted' in addition to deletedAt, and refuses to delete an already-deleted document twice via the transition guard implicitly (idempotent no-op)", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "To be deleted",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from(`delete me ${generateId("document")}`, "utf8"),
    });
    createdDocumentIds.push(documentId);

    await documents.delete(documentId, ownerUserId);
    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(row?.processingState).toBe("deleted");
    expect(row?.deletedAt).not.toBeNull();

    // A second delete call is a harmless no-op, not a thrown transition error.
    await expect(documents.delete(documentId, ownerUserId)).resolves.not.toThrow();
  });

  describe("isValidProcessingStateTransition — no invalid transitions", () => {
    it("never allows any transition back into 'uploaded', including restoring an archived document", () => {
      expect(isValidProcessingStateTransition("archived", "uploaded")).toBe(false);
      expect(isValidProcessingStateTransition("verified", "uploaded")).toBe(false);
      expect(isValidProcessingStateTransition("classified", "uploaded")).toBe(false);
    });

    it("deletion is final — nothing transitions out of 'deleted'", () => {
      expect(isValidProcessingStateTransition("deleted", "archived")).toBe(false);
      expect(isValidProcessingStateTransition("deleted", "uploaded")).toBe(false);
      expect(isValidProcessingStateTransition("deleted", "verified")).toBe(false);
      expect(isValidProcessingStateTransition("deleted", "deleted")).toBe(true); // idempotent no-op
    });

    it("a superseded document can still be archived/deleted, but never revived into the live pipeline", () => {
      expect(isValidProcessingStateTransition("superseded", "archived")).toBe(true);
      expect(isValidProcessingStateTransition("superseded", "deleted")).toBe(true);
      expect(isValidProcessingStateTransition("superseded", "verified")).toBe(false);
      expect(isValidProcessingStateTransition("superseded", "linked")).toBe(false);
    });

    it("the pipeline only ever moves forward, never sideways or backward", () => {
      expect(isValidProcessingStateTransition("uploaded", "classified")).toBe(true);
      expect(isValidProcessingStateTransition("classified", "extracted")).toBe(true);
      expect(isValidProcessingStateTransition("extracted", "linked")).toBe(true);
      expect(isValidProcessingStateTransition("linked", "verified")).toBe(true);
      expect(isValidProcessingStateTransition("verified", "extracted")).toBe(false);
      expect(isValidProcessingStateTransition("extracted", "classified")).toBe(false);
      expect(isValidProcessingStateTransition("linked", "linked")).toBe(true); // idempotent
    });

    it("any live pipeline stage can go directly to superseded/archived/deleted", () => {
      for (const from of ["uploaded", "classified", "extracted", "linked", "verified"] as const) {
        expect(isValidProcessingStateTransition(from, "superseded")).toBe(true);
        expect(isValidProcessingStateTransition(from, "archived")).toBe(true);
        expect(isValidProcessingStateTransition(from, "deleted")).toBe(true);
      }
    });
  });
});
