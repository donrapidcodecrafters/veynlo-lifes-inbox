import { createHash } from "node:crypto";
import { ZipArchive } from "archiver";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import heicConvert from "heic-convert";
import { generateId, DocumentTypeSchema, type DocumentType } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../shared/sharing.service";
import { SearchIndexService } from "../search/search-index.service";
import { BillingService } from "../billing/billing.service";
import { StorageService } from "./storage.service";
import { MalwareScannerService } from "./malware-scanner.service";

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "text/plain"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — generous for scanned receipts/manuals, bounded against abuse
// DOC-007 "export packet" — a naive mimeType.split("/")[1] gives "plain" for text/plain and "jpeg" works
// only by coincidence; this maps every ALLOWED_MIME_TYPES entry to the extension a user's OS actually
// recognizes.
const MIME_EXTENSIONS: Record<string, string> = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "text/plain": "txt" };
// Backend-robustness audit finding — GET /v1/documents had no limit/cursor at all, an unbounded query that
// degrades badly for any account with a real document history. Same cursor-pagination shape as Timeline's
// (`before` cursor, fetch PAGE_SIZE+1, slice+nextCursor) for consistency across the app's list endpoints.
const DOCUMENTS_PAGE_SIZE = 30;

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly ai: AnthropicExtractionService,
    private readonly malwareScanner: MalwareScannerService,
    private readonly households: HouseholdService,
    private readonly sharing: SharingService,
    private readonly searchIndex: SearchIndexService,
    private readonly billing: BillingService,
  ) {}

  /** §46 entitlement enforcement — `document_storage_mb` was defined in `PLAN_CATALOG` (free: 250MB, up to
   * pro_agent: 200GB) with nothing anywhere checking it. Sums every version's `sizeBytes` (not just each
   * document's current version) — an old version still occupies real storage until its retention policy
   * deletes the blob, so it has to count against the cap the same way. */
  private async assertStorageQuota(ownerUserId: string, incomingBytes: number): Promise<void> {
    const maxMb = await this.billing.getCapability(ownerUserId, "document_storage_mb");
    if (maxMb === null) return; // unlimited
    const [row] = await this.db
      .select({ totalBytes: sql<string>`coalesce(sum(${schema.documentVersions.sizeBytes}), 0)` })
      .from(schema.documentVersions)
      .innerJoin(schema.documents, eq(schema.documentVersions.documentId, schema.documents.id))
      .where(eq(schema.documents.ownerUserId, ownerUserId));
    const currentBytes = Number(row?.totalBytes ?? 0);
    const maxBytes = (maxMb as number) * 1024 * 1024;
    if (currentBytes + incomingBytes > maxBytes) {
      throw new ForbiddenException({
        code: "PLAN_LIMIT_REACHED",
        message: `You've reached your plan's ${maxMb}MB document storage limit. Upgrade your plan or delete some documents to free up space.`,
      });
    }
  }

  /**
   * FAM-006 enforcement, mirroring CommerceService/ScheduleService's identically-named helper. A
   * delegated household's documents additionally exclude `visibility: "private"` — a member's explicitly
   * private document shouldn't leak to a caregiver just because they hold a household-wide grant; the
   * owner's own documents are never filtered by visibility.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn, visibilityCol: AnyPgColumn) {
    const householdIds = await this.households.delegatedHouseholdIds(userId, "documents:read");
    if (householdIds.length === 0) return eq(ownerCol, userId);
    return or(eq(ownerCol, userId), and(inArray(householdCol, householdIds), ne(visibilityCol, "private")))!;
  }

  /**
   * The MIME check above is just the client-supplied Content-Type header — fully attacker-controlled, so
   * an executable or HTML file mislabeled as "application/pdf" would otherwise sail straight through it and
   * get stored/served back under that claimed type. This sniffs the file's real magic bytes (via the
   * `file-type` package, ESM-only hence the dynamic import from this CommonJS module) and rejects any
   * mismatch between what's claimed and what the content actually is.
   */
  private async assertMagicBytesMatchClaimedMime(buffer: Buffer, claimedMimeType: string): Promise<void> {
    type FileTypeModule = { fileTypeFromBuffer: (b: Buffer) => Promise<{ ext: string; mime: string } | undefined> };
    // @ts-expect-error -- file-type is ESM-only; this repo's Node10 moduleResolution can't resolve its
    // `exports` map for type-checking, but the dynamic import itself works fine at runtime under Node.
    const { fileTypeFromBuffer } = (await import("file-type")) as FileTypeModule;
    const detected = await fileTypeFromBuffer(buffer);
    // file-type only detects binary formats by design (it has no signature for plain text) — a confident
    // binary-format detection here means the buffer isn't really plain text no matter what was claimed.
    const mismatch = claimedMimeType === "text/plain" ? Boolean(detected) : detected?.mime !== claimedMimeType;
    if (mismatch) {
      throw new BadRequestException({
        code: "FILE_CONTENT_MISMATCH",
        message: "This file's content doesn't match its claimed type.",
      });
    }
  }

  async upload(params: {
    ownerUserId: string;
    householdId: string | null;
    title: string;
    documentType: DocumentType;
    mimeType: string;
    buffer: Buffer;
    /** TIME-002 "attach document" — an opaque `resourceId`, self-describing via its own generateId prefix (same "opaque, prefixed resource IDs" design already used everywhere else), not a separate resourceType column. */
    linkedResourceId?: string;
    /** CAP-004 "duplicate hash detection" — set once the caller has seen a `duplicate: true` response and wants to upload anyway (e.g. a genuinely separate copy for another purpose). */
    force?: boolean;
  }): Promise<{ documentId: string; duplicate?: true; duplicateOfTitle?: string }> {
    if (params.buffer.length === 0) {
      throw new BadRequestException({ code: "EMPTY_FILE", message: "The uploaded file is empty." });
    }
    if (params.buffer.length > MAX_UPLOAD_BYTES) {
      throw new BadRequestException({ code: "FILE_TOO_LARGE", message: "Files must be 25MB or smaller." });
    }
    if (!ALLOWED_MIME_TYPES.has(params.mimeType)) {
      throw new BadRequestException({
        code: "UNSUPPORTED_FILE_TYPE",
        message: `${params.mimeType} isn't supported yet. Try PDF, JPG, PNG, HEIC, or plain text.`,
      });
    }
    await this.assertMagicBytesMatchClaimedMime(params.buffer, params.mimeType);

    await this.assertStorageQuota(params.ownerUserId, params.buffer.length);

    // Scanned before any DB row or storage write exists, so a rejected upload never leaves a partial
    // document behind to clean up. Skipped (not failed) when unconfigured — CLAMD_HOST unset means this
    // deployment hasn't wired up a scanner yet, same graceful-degradation posture as the optional
    // connectors; but once it IS configured, a scan failure fails closed (rejects the upload) rather than
    // silently accepting an unscanned file — see MalwareScannerService's own doc comment.
    if (this.malwareScanner.isConfigured()) {
      let result: { infected: boolean; signature?: string };
      try {
        result = await this.malwareScanner.scan(params.buffer);
      } catch (err) {
        this.logger.error(`Malware scan failed, rejecting upload: ${String(err)}`);
        throw new ServiceUnavailableException({
          code: "MALWARE_SCAN_UNAVAILABLE",
          message: "Couldn't scan this file right now. Please try again shortly.",
        });
      }
      if (result.infected) {
        throw new BadRequestException({
          code: "MALWARE_DETECTED",
          message: `This file was flagged as malicious (${result.signature}) and was not uploaded.`,
        });
      }
    }

    const contentHash = createHash("sha256").update(params.buffer).digest("hex");

    // CAP-004 "duplicate hash detection" — `contentHash` was computed and stored on every version already,
    // but nothing ever checked it against existing rows, so uploading the same file twice silently created
    // two fully independent documents. Scoped to this owner's own documents, not global, so someone else
    // having uploaded byte-identical content (e.g. a shared form's boilerplate PDF) never surfaces.
    if (!params.force) {
      const [existingMatch] = await this.db
        .select({ documentId: schema.documentVersions.documentId, title: schema.documents.title })
        .from(schema.documentVersions)
        .innerJoin(schema.documents, eq(schema.documentVersions.documentId, schema.documents.id))
        .where(and(eq(schema.documentVersions.contentHash, contentHash), eq(schema.documents.ownerUserId, params.ownerUserId)))
        .limit(1);
      if (existingMatch) {
        return { documentId: existingMatch.documentId, duplicate: true, duplicateOfTitle: existingMatch.title };
      }
    }

    const documentId = generateId("document");
    const versionId = generateId("documentVersion");
    const blobKey = `documents/${params.ownerUserId}/${documentId}/v1`;

    await this.db.insert(schema.documents).values({
      id: documentId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      documentType: params.documentType,
      title: params.title,
      // Explicit rather than relying on the column's `.default([])` — encrypted-jsonb columns don't
      // actually get a working DB-level default (the migration can't statically express a runtime-
      // encrypted default value; see packages/db/src/migrations/0003_daffy_mister_fear.sql's own history
      // of this), so omitting this crashed every real upload with a NOT NULL violation on `tags`.
      tags: [],
      sensitivity: "sensitive",
      visibility: "private",
      // No explicit processingState here — defaults to "uploaded", which is now accurate: scanning (when
      // configured) already happened above, before this row exists at all.
      currentVersionId: versionId,
      linkedEntityIds: params.linkedResourceId ? [params.linkedResourceId] : [],
    });

    await this.storage.putObject(blobKey, params.buffer, params.mimeType);

    let ocrText: string | null = null;
    let ocrConfidence: number | null = null;
    if (params.mimeType === "text/plain") {
      ocrText = params.buffer.toString("utf8").slice(0, 50_000);
      ocrConfidence = 1;
    } else if (this.ai.isConfigured()) {
      try {
        ocrText = await this.extractTextWithClaude(params.buffer, params.mimeType);
        ocrConfidence = ocrText ? 0.75 : null;
      } catch (err) {
        this.logger.warn(`OCR extraction failed for ${documentId}: ${String(err)}`);
      }
    }

    // DOC-001 "AI classification" — documentType was previously purely whatever the client sent at
    // upload time (mobile's picker defaults to "receipt" for everything), never predicted or corrected
    // from the document's actual content. Runs after OCR since classification needs real text to work
    // from; a failure here is non-fatal (keeps the client-provided type) same posture as OCR above.
    let classifiedType: DocumentType | null = null;
    if (ocrText && this.ai.isConfigured()) {
      try {
        classifiedType = await this.classifyDocumentType(ocrText);
      } catch (err) {
        this.logger.warn(`Classification failed for ${documentId}: ${String(err)}`);
      }
    }

    await this.db.insert(schema.documentVersions).values({
      id: versionId,
      documentId,
      versionNumber: 1,
      blobRef: blobKey,
      contentHash,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      ocrText,
      ocrConfidence,
    });

    await this.db
      .update(schema.documents)
      .set({
        processingState: ocrText ? "extracted" : "classified",
        ...(classifiedType ? { documentType: classifiedType } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, documentId));

    await this.reindexDocument(documentId);

    return { documentId };
  }

  /** Re-derives a document's `search_documents` row from its current title + current version's OCR text —
   * called after anything that can change either (a new upload, a rename, a new version becoming current)
   * rather than each call site trying to patch the indexed text itself. */
  private async reindexDocument(documentId: string): Promise<void> {
    const [row] = await this.db
      .select({ document: schema.documents, version: schema.documentVersions })
      .from(schema.documents)
      .leftJoin(schema.documentVersions, eq(schema.documentVersions.id, schema.documents.currentVersionId))
      .where(eq(schema.documents.id, documentId))
      .limit(1);
    if (!row) return;
    await this.searchIndex.upsert({
      resourceType: "document",
      resourceId: documentId,
      ownerUserId: row.document.ownerUserId,
      householdId: row.document.householdId,
      title: row.document.title,
      bodyText: row.version?.ocrText ?? "",
    });
  }

  private async extractTextWithClaude(buffer: Buffer, mimeType: string): Promise<string | null> {
    // Real vision/document input (base64), not a text description — Claude only ever "sees" bytes it was
    // actually given. This is a legitimate OCR substitute for MVP volumes; a dedicated OCR engine is worth
    // adding once usage/cost data justifies it (see docs/ROADMAP.md).
    if (mimeType === "application/pdf") {
      const result = await this.ai.extractStructured({
        extractorName: "document_ocr_pdf_v1",
        model: "cheap",
        systemPrompt: "Transcribe all readable text from this PDF verbatim, in reading order. If unreadable, say so.",
        userContent: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") } },
          { type: "text", text: "Transcribe this document." },
        ],
        schema: z.object({ transcribedText: z.string() }),
        toolDescription: "Emit the transcribed PDF text.",
      });
      return result?.data.transcribedText ?? null;
    }
    if (mimeType === "image/heic") {
      // Claude's vision input only accepts jpeg/png/gif/webp, not HEIC — the default photo format on
      // iPhone, so this is a real, commonly-hit case (previously silently skipped OCR entirely for it,
      // despite HEIC being explicitly listed as an accepted upload type in both the MIME allowlist above
      // and the "isn't supported yet... Try PDF, JPG, PNG, HEIC" error message). Transcodes to JPEG first,
      // then reuses the exact same vision call as any other image.
      const jpeg = await heicConvert({ buffer: new Uint8Array(buffer), format: "JPEG", quality: 0.92 });
      return this.transcribeImage(Buffer.from(jpeg), "image/jpeg");
    }
    if (mimeType.startsWith("image/")) {
      return this.transcribeImage(buffer, mimeType as "image/jpeg" | "image/png");
    }
    return null;
  }

  /** DOC-001 "AI classification" — predicts documentType from the document's actual OCR'd content,
   * rather than trusting whatever the client happened to send at upload time. */
  private async classifyDocumentType(ocrText: string): Promise<DocumentType | null> {
    const result = await this.ai.extractStructured({
      extractorName: "document_classification_v1",
      model: "cheap",
      systemPrompt:
        'Classify this document into exactly one type. Choose "other" only if none of the other types clearly fit.',
      userContent: ocrText.slice(0, 8_000),
      schema: z.object({ documentType: DocumentTypeSchema }),
      toolDescription: "Emit the classified document type.",
    });
    return result?.data.documentType ?? null;
  }

  private async transcribeImage(buffer: Buffer, mediaType: "image/jpeg" | "image/png"): Promise<string | null> {
    const result = await this.ai.extractStructured({
      extractorName: "document_ocr_image_v1",
      model: "cheap",
      systemPrompt: "Transcribe all readable text from this image verbatim. If unreadable, say so.",
      userContent: [
        { type: "image", source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") } },
        { type: "text", text: "Transcribe this image." },
      ],
      schema: z.object({ transcribedText: z.string() }),
      toolDescription: "Emit the transcribed image text.",
    });
    return result?.data.transcribedText ?? null;
  }

  async list(userId: string, before?: string | null): Promise<{ items: (typeof schema.documents.$inferSelect)[]; nextCursor: string | null }> {
    const ownerCondition = await this.ownerOrDelegatedHousehold(
      userId,
      schema.documents.ownerUserId,
      schema.documents.householdId,
      schema.documents.visibility,
    );
    const beforeDate = before ? new Date(before) : null;
    const rows = await this.db
      .select()
      .from(schema.documents)
      .where(beforeDate ? and(ownerCondition, lt(schema.documents.createdAt, beforeDate)) : ownerCondition)
      .orderBy(desc(schema.documents.createdAt))
      .limit(DOCUMENTS_PAGE_SIZE + 1);
    const hasMore = rows.length > DOCUMENTS_PAGE_SIZE;
    const items = hasMore ? rows.slice(0, DOCUMENTS_PAGE_SIZE) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.createdAt.toISOString() : null };
  }

  /** TIME-002 "Object history" — documents attached to one specific resource (e.g. a purchase's receipt
   * scan). Deliberately NOT built on the paginated `list()` above — this needs every one of the owner's
   * documents scanned for a linkedEntityIds match, not just the most recent page. */
  async listLinkedTo(userId: string, resourceId: string) {
    const ownerCondition = await this.ownerOrDelegatedHousehold(
      userId,
      schema.documents.ownerUserId,
      schema.documents.householdId,
      schema.documents.visibility,
    );
    const owned = await this.db.select().from(schema.documents).where(ownerCondition);
    return owned.filter((d) => d.linkedEntityIds.includes(resourceId));
  }

  async signedUrl(documentId: string, userId: string, versionId?: string): Promise<string> {
    const doc = await this.assertOwnedDocument(documentId, userId);
    const targetVersionId = versionId ?? doc.currentVersionId;
    if (!targetVersionId) throw new NotFoundException({ code: "NO_VERSION", message: "No file version available." });
    const [version] = await this.db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, targetVersionId)).limit(1);
    if (!version || version.documentId !== documentId) throw new NotFoundException({ code: "NO_VERSION", message: "No file version available." });
    return this.storage.signedGetUrl(version.blobRef);
  }

  /** DOC-006/DOC-001 "rename, correct type, tag" — write-once-at-upload before this; the only mutation available afterward. */
  async updateMetadata(documentId: string, userId: string, dto: { title?: string; documentType?: DocumentType; tags?: string[] }) {
    await this.assertDocumentOwner(documentId, userId);
    const patch: Partial<typeof schema.documents.$inferInsert> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.documentType !== undefined) patch.documentType = dto.documentType;
    if (dto.tags !== undefined) patch.tags = dto.tags;
    await this.db.update(schema.documents).set(patch).where(eq(schema.documents.id, documentId));
    if (dto.title !== undefined) await this.reindexDocument(documentId);
  }

  /** DOC-006 "link/unlink object" — the other half of TIME-002's "attach document" (linking happens at upload time via `linkedResourceId`). */
  async unlinkResource(documentId: string, userId: string, resourceId: string) {
    const doc = await this.assertDocumentOwner(documentId, userId);
    await this.db
      .update(schema.documents)
      .set({ linkedEntityIds: doc.linkedEntityIds.filter((id) => id !== resourceId), updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));
  }

  /**
   * DOC-008 "retention policy" — "full_original" keeps the file; the other two both mean deleting the
   * actual blob, keeping only what's already independently stored (the row itself, and each version's own
   * OCR'd text on document_versions). Irreversible: once a blob is deleted there's nothing to restore it
   * from, which is exactly what the spec's "explain loss of evidence if originals are removed" warns about
   * — the confirmation copy lives in the UI, this method just does what it's told once confirmed.
   */
  async setRetention(documentId: string, userId: string, retentionPolicy: "full_original" | "extracted_only" | "delete_after_processing") {
    await this.assertDocumentOwner(documentId, userId);
    if (retentionPolicy !== "full_original") {
      const versions = await this.db.select({ blobRef: schema.documentVersions.blobRef }).from(schema.documentVersions).where(eq(schema.documentVersions.documentId, documentId));
      for (const version of versions) await this.storage.deleteObject(version.blobRef).catch(() => undefined);
    }
    await this.db.update(schema.documents).set({ retentionPolicy, updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /**
   * §HH-002 "object-level privacy badge" — real, previously-missing gap: ownerOrDelegatedHousehold above
   * has correctly filtered out `visibility: "private"` documents from a delegate's view since that
   * check was built, but nothing anywhere ever set a document's visibility to anything but "private" at
   * creation — the whole caregiver-delegation feature (documents:read scope) was functionally inert
   * because there was never a real item for a delegate to actually see. "selected_people"/"shared_link"
   * aren't offered here — this codebase's actual enforcement only distinguishes private vs. not-private
   * today (see the ne(visibilityCol, "private") check), so offering finer-grained values here would be a
   * control with no real backing logic yet.
   */
  async setVisibility(documentId: string, userId: string, visibility: "private" | "household") {
    const document = await this.assertDocumentOwner(documentId, userId);
    if (visibility === "household" && !document.householdId) {
      throw new BadRequestException({
        code: "NO_HOUSEHOLD",
        message: "This account isn't part of a household yet, so there's no one to share this with.",
      });
    }
    await this.db.update(schema.documents).set({ visibility, updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /** §Sharing expansion — same shape as AttentionService's identical pair, generalized via SharingService. */
  async createShareLink(documentId: string, userId: string) {
    await this.assertDocumentOwner(documentId, userId);
    return this.sharing.createShareLink("document", documentId, userId);
  }

  async revokeShareLinks(documentId: string, userId: string) {
    await this.assertDocumentOwner(documentId, userId);
    await this.sharing.revokeShareLinks("document", documentId, userId);
  }

  /**
   * SHARE-001 "direct object sharing to a specific household member" — distinct from setVisibility's
   * household-wide toggle: grants exactly one named household member view access, regardless of whether
   * the document is "private" or "household" visible. Owner-only (assertDocumentOwner), grantee must be a
   * real active member of the SAME household the document belongs to — sharing outside your own household
   * isn't offered here (that's what the public share link is for).
   */
  async shareWithMember(documentId: string, userId: string, granteeUserId: string) {
    const document = await this.assertDocumentOwner(documentId, userId);
    if (!document.householdId) {
      throw new BadRequestException({ code: "NO_HOUSEHOLD", message: "This account isn't part of a household yet, so there's no one to share this with." });
    }
    if (granteeUserId === userId) {
      throw new BadRequestException({ code: "SELF_GRANT", message: "You already have access to your own document." });
    }
    const [membership] = await this.db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, document.householdId), eq(schema.householdMemberships.userId, granteeUserId), eq(schema.householdMemberships.status, "active")));
    if (!membership) {
      throw new BadRequestException({ code: "NOT_A_MEMBER", message: "That person isn't an active member of your household." });
    }
    return this.sharing.grantAccess("document", documentId, granteeUserId, userId);
  }

  async revokeMemberAccess(documentId: string, userId: string, grantId: string) {
    await this.assertDocumentOwner(documentId, userId);
    await this.sharing.revokeGrant(grantId, userId);
  }

  async listMemberGrants(documentId: string, userId: string) {
    await this.assertDocumentOwner(documentId, userId);
    return this.sharing.listGrants("document", documentId);
  }

  /**
   * DOC-007 "export packet" — a user-selected ZIP bundle of original files, for insurance/taxes/travel/
   * home-sale/etc. Bounded scope: the original-file bundle only (a "ZIP/PDF index packet" summary document
   * isn't attempted — that would mean generating a real PDF report, a separate, larger feature). Skips
   * (rather than fails) a document whose blob was already deleted under a non-"full_original" retention
   * policy — nothing to include, but that's not a reason to fail the whole export.
   */
  async exportPacket(documentIds: string[], userId: string): Promise<{ filename: string; buffer: Buffer }> {
    const chunks: Buffer[] = [];
    const archive = new ZipArchive({ zlib: { level: 9 } });
    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<void>((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);
    });

    const usedNames = new Set<string>();
    for (const documentId of documentIds) {
      const doc = await this.assertOwnedDocument(documentId, userId);
      if (!doc.currentVersionId) continue;
      const [version] = await this.db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, doc.currentVersionId)).limit(1);
      if (!version) continue;
      const bytes = await this.storage.getObject(version.blobRef).catch(() => null);
      if (!bytes) continue; // retention policy already deleted this blob — nothing to bundle
      const extension = MIME_EXTENSIONS[version.mimeType] ?? version.mimeType.split("/")[1] ?? "bin";
      let name = `${doc.title.replace(/[/\\]/g, "_")}.${extension}`;
      if (usedNames.has(name)) name = `${doc.title.replace(/[/\\]/g, "_")}-${doc.id}.${extension}`;
      usedNames.add(name);
      archive.append(bytes, { name });
    }

    archive.finalize();
    await done;
    return { filename: `veynlo-documents-${new Date().toISOString().slice(0, 10)}.zip`, buffer: Buffer.concat(chunks) };
  }

  /** DOC-001/DOC-006 "delete" — no delete endpoint existed at all before this. Removes every version's blob from storage before the DB row (cascades to document_versions), so nothing orphaned is left in the bucket. */
  async deleteDocument(documentId: string, userId: string) {
    await this.assertDocumentOwner(documentId, userId);
    const versions = await this.db.select({ blobRef: schema.documentVersions.blobRef }).from(schema.documentVersions).where(eq(schema.documentVersions.documentId, documentId));
    for (const version of versions) await this.storage.deleteObject(version.blobRef).catch(() => undefined);
    await this.db.delete(schema.documents).where(eq(schema.documents.id, documentId));
    await this.searchIndex.remove("document", documentId);
  }

  /**
   * DOC-004 "versioning" — previously every upload created a brand-new `documents` row; `document_versions`
   * was 1:1 in practice (schema/name only). This is the first real writer of a SECOND version against an
   * EXISTING document: same scan/storage/OCR pipeline as `upload()`, but targeting `documentId` and
   * incrementing `versionNumber` instead of always starting a fresh document.
   */
  async addVersion(documentId: string, userId: string, params: { mimeType: string; buffer: Buffer }): Promise<{ versionId: string }> {
    const doc = await this.assertDocumentOwner(documentId, userId);
    if (params.buffer.length === 0) throw new BadRequestException({ code: "EMPTY_FILE", message: "The uploaded file is empty." });
    if (params.buffer.length > MAX_UPLOAD_BYTES) throw new BadRequestException({ code: "FILE_TOO_LARGE", message: "Files must be 25MB or smaller." });
    if (!ALLOWED_MIME_TYPES.has(params.mimeType)) {
      throw new BadRequestException({ code: "UNSUPPORTED_FILE_TYPE", message: `${params.mimeType} isn't supported yet. Try PDF, JPG, PNG, HEIC, or plain text.` });
    }
    await this.assertMagicBytesMatchClaimedMime(params.buffer, params.mimeType);
    await this.assertStorageQuota(doc.ownerUserId, params.buffer.length);
    if (this.malwareScanner.isConfigured()) {
      const result = await this.malwareScanner.scan(params.buffer).catch(() => {
        throw new ServiceUnavailableException({ code: "MALWARE_SCAN_UNAVAILABLE", message: "Couldn't scan this file right now. Please try again shortly." });
      });
      if (result.infected) throw new BadRequestException({ code: "MALWARE_DETECTED", message: `This file was flagged as malicious (${result.signature}) and was not uploaded.` });
    }

    const [latestVersion] = await this.db
      .select({ versionNumber: schema.documentVersions.versionNumber })
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, documentId))
      .orderBy(sql`${schema.documentVersions.versionNumber} desc`)
      .limit(1);
    const nextVersionNumber = (latestVersion?.versionNumber ?? 0) + 1;

    const contentHash = createHash("sha256").update(params.buffer).digest("hex");
    const versionId = generateId("documentVersion");
    const blobKey = `documents/${userId}/${documentId}/v${nextVersionNumber}`;
    await this.storage.putObject(blobKey, params.buffer, params.mimeType);

    let ocrText: string | null = null;
    let ocrConfidence: number | null = null;
    if (params.mimeType === "text/plain") {
      ocrText = params.buffer.toString("utf8").slice(0, 50_000);
      ocrConfidence = 1;
    } else if (this.ai.isConfigured()) {
      try {
        ocrText = await this.extractTextWithClaude(params.buffer, params.mimeType);
        ocrConfidence = ocrText ? 0.75 : null;
      } catch (err) {
        this.logger.warn(`OCR extraction failed for ${documentId} v${nextVersionNumber}: ${String(err)}`);
      }
    }

    // DOC-001 "AI classification" — a replaced version's content may be entirely different from the
    // original (e.g. a placeholder re-uploaded with the real file), so re-classify the same as upload().
    let classifiedType: DocumentType | null = null;
    if (ocrText && this.ai.isConfigured()) {
      try {
        classifiedType = await this.classifyDocumentType(ocrText);
      } catch (err) {
        this.logger.warn(`Classification failed for ${documentId} v${nextVersionNumber}: ${String(err)}`);
      }
    }

    await this.db.insert(schema.documentVersions).values({
      id: versionId,
      documentId,
      versionNumber: nextVersionNumber,
      blobRef: blobKey,
      contentHash,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      ocrText,
      ocrConfidence,
    });
    await this.db
      .update(schema.documents)
      .set({
        currentVersionId: versionId,
        processingState: ocrText ? "extracted" : "classified",
        ...(classifiedType ? { documentType: classifiedType } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.documents.id, documentId));

    await this.reindexDocument(documentId);

    return { versionId };
  }

  /** DOC-004 "compare versions" — a real, bounded interpretation: version metadata plus a plain line-count diff of each version's OCR'd text against the one before it, not a full character-level diff UI. */
  async listVersions(documentId: string, userId: string) {
    await this.assertOwnedDocument(documentId, userId);
    const versions = await this.db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.documentId, documentId))
      .orderBy(asc(schema.documentVersions.versionNumber));

    return versions.map((v, i) => {
      const previous = versions[i - 1];
      const diff = previous ? diffLineCounts(previous.ocrText, v.ocrText) : null;
      return {
        id: v.id,
        versionNumber: v.versionNumber,
        sizeBytes: v.sizeBytes,
        mimeType: v.mimeType,
        ocrText: v.ocrText,
        createdAt: v.createdAt,
        isCurrent: v.id === (versions[versions.length - 1]?.id ?? null),
        diffFromPrevious: diff,
      };
    });
  }

  /** Read access only — a "documents:read" delegate can reach a non-private household document through
   * this. Genuine mutations must use assertDocumentOwner below instead; this was previously (incorrectly)
   * shared by both, which let a read-only delegate delete/overwrite/re-share another member's document —
   * see assertDocumentOwner's own comment. */
  private async assertOwnedDocument(documentId: string, userId: string) {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId === userId) return doc;
    const householdIds = doc.householdId && doc.visibility !== "private" ? await this.households.delegatedHouseholdIds(userId, "documents:read") : [];
    if (doc.householdId && householdIds.includes(doc.householdId)) return doc;
    // SHARE-001 direct object grant — works regardless of visibility/household-delegation, since a specific
    // named grant is a stronger, more targeted authorization than either of those.
    if (await this.sharing.hasActiveGrant("document", documentId, userId)) return doc;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
  }

  /**
   * Strict owner-only — for every real mutation (rename/retag, unlink, retention, visibility, share-link
   * create/revoke, delete, new version). `assertOwnedDocument` above deliberately allows a "documents:read"
   * household delegate through for non-private documents, which is correct for genuine reads (view/download/
   * list versions) but was a real privilege-escalation bug when the exact same check also gated these
   * mutations: a delegate with READ-only access could delete another member's document, overwrite its
   * content, destroy the original file via retention policy, or mint a public share link for it. Matches
   * ScheduleService's identical strict-owner pattern for its own mutations.
   */
  private async assertDocumentOwner(documentId: string, userId: string) {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    return doc;
  }
}

/** Simple line-level diff summary (added/removed/unchanged line counts) — bounded and honest about what "compare versions" means here: not a rendered diff view, just enough signal to tell a user whether a re-upload actually changed the extracted content. */
function diffLineCounts(previousText: string | null, currentText: string | null): { linesAdded: number; linesRemoved: number; unchanged: boolean } {
  const previousLines = new Set((previousText ?? "").split("\n"));
  const currentLines = new Set((currentText ?? "").split("\n"));
  const linesAdded = [...currentLines].filter((l) => !previousLines.has(l)).length;
  const linesRemoved = [...previousLines].filter((l) => !currentLines.has(l)).length;
  return { linesAdded, linesRemoved, unchanged: linesAdded === 0 && linesRemoved === 0 };
}
