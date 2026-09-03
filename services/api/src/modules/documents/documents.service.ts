import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { and, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import heicConvert from "heic-convert";
import { generateId, type DocumentType, type DocumentProcessingState } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { MODEL_PROVIDER, type ModelProvider } from "../intelligence/model-provider.interface";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { OBJECT_STORAGE, type ObjectStorage } from "./object-storage.interface";
import { MalwareScannerService } from "./malware-scanner.service";
import { matchesFileSignature } from "./file-signature";
import { approxPdfPageCount } from "./pdf-page-count";
import { SharingService } from "../sharing/sharing.service";
import type { CreateShareLinkDto } from "../sharing/dto";
import { SearchIndexService } from "../search/search-index.service";
import { DOCUMENT_PROCESSING_PIPELINE, isValidProcessingStateTransition } from "./processing-state";
import type { DocumentListFilter } from "./dto";

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "text/plain"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — generous for scanned receipts/manuals, bounded against abuse
const MAX_PDF_PAGES = 100; // matches Anthropic's own documented per-request PDF page limit

/**
 * §27 "Health Logistics" (HLTH-002 "insurance card/document vault"). Rather than a parallel document
 * system, this reuses the existing vault wholesale (same upload/list/OCR/sharing machinery) with two
 * targeted differences applied only to these two `documentType`s: (1) `upload()` below defaults their
 * `sensitivity` to "highly_sensitive" instead of the ordinary "sensitive" default every other document type
 * gets; (2) `documentDetail`/`signedUrl` below never grant access via plain household membership for these
 * types, even when `visibility` is "household" — the spec's own line, "Sensitive category can require
 * reauth and remain private even inside family plan," means household membership alone must not be
 * sufficient the way it is for an ordinary shared document. `HealthLogisticsService.openHealthDocument`
 * additionally requires a fresh step-up password (IdentityService.verifyStepUpPassword) on top of this
 * baseline access check before ever minting a signed URL for one of these.
 */
export const HEALTH_DOCUMENT_TYPES = new Set(["insurance_card", "eob"]);

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(MODEL_PROVIDER) private readonly ai: ModelProvider,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(MalwareScannerService) private readonly malwareScanner: MalwareScannerService,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(SharingService) private readonly sharing: SharingService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional `new
    // DocumentsService(...)` test construction across this module keeps compiling unchanged; undefined
    // just means `upload`/`processOcr` skip reindexing (a no-op, not an error).
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  /**
   * FAM-006 enforcement, mirroring CommerceService/ScheduleService/ListsService/AssetsService's
   * identically-named helper. A delegated household's documents additionally exclude `visibility:
   * "private"` — a member's explicitly private document shouldn't leak to a caregiver just because they
   * hold a household-wide grant; the owner's own documents are never filtered by visibility.
   *
   * Also OR's in plain active membership alongside delegation (see HouseholdService.activeHouseholdIds's
   * own doc comment) — same systemic gap found and fixed across every other domain this session: a
   * household-shared document was invisible to an ordinary member (only the creator or an explicitly
   * caregiver-delegated user could see it), since `acceptInvite` never grants a delegation on its own.
   *
   * HLTH-002 gap fix, found live during a requirements re-audit: `documentDetail`/`signedUrl` both
   * correctly carve `HEALTH_DOCUMENT_TYPES` out of household-implied visibility (see this module's own doc
   * comment on that constant — an insurance card/EOB must "remain private even inside family plan," full
   * stop, regardless of `visibility`), but this helper — `list()`'s only access-control gate — never
   * applied the same carve-out. That meant a household member's insurance card or EOB (set to
   * `visibility: "household"` via `setHousehold`) showed up by title/type/expiry in every other member's
   * `GET /v1/documents`, even though opening it (`documentDetail`/`signedUrl`) correctly 403'd them —
   * metadata-only exposure (no file content, no OCR text — `list()` never selects `documentVersions`), but
   * still a direct contradiction of HLTH-002's own privacy guarantee. Matches `documentDetail`/`signedUrl`'s
   * shape exactly now: a health-tagged document is reachable only via ownership or an explicit resourceGrant
   * (checked separately in `list()`'s caller, via `grantedResourceIds`), never via household membership.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn, visibilityCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "documents:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    if (householdIds.length === 0) return eq(ownerCol, userId);
    return or(
      eq(ownerCol, userId),
      and(inArray(householdCol, householdIds), ne(visibilityCol, "private"), notInArray(schema.documents.documentType, [...HEALTH_DOCUMENT_TYPES])),
    )!;
  }

  /** Phase 2 §52.2 cloud-file connectors — lets an adapter (Google Drive/OneDrive/Dropbox) skip
   * re-importing a file it already pulled in on a prior sync, without needing a separate provider-file-id
   * tracking table. `contentHash` is a plain (unencrypted) column on `documentVersions`, so this is a
   * direct SQL equality check, not an application-layer decrypt-and-compare. */
  async findByContentHash(ownerUserId: string, contentHash: string): Promise<boolean> {
    const [existing] = await this.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .innerJoin(schema.documentVersions, eq(schema.documentVersions.documentId, schema.documents.id))
      .where(and(eq(schema.documents.ownerUserId, ownerUserId), eq(schema.documentVersions.contentHash, contentHash)))
      .limit(1);
    return Boolean(existing);
  }

  /** `upload()`'s own automatic-supersede lookup — see that call site's doc comment. Deliberately excludes
   * `superseded`/`deleted` rows (a document already retired shouldn't be re-retired by a later re-upload;
   * whichever live document is currently "the" one for this content is the one that should absorb the new
   * upload's supersession), and is scoped per-owner exactly like `findByContentHash` above. */
  private async findLiveDuplicateByContentHash(ownerUserId: string, contentHash: string): Promise<{ id: string } | null> {
    const [existing] = await this.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .innerJoin(schema.documentVersions, eq(schema.documentVersions.documentId, schema.documents.id))
      .where(
        and(
          eq(schema.documents.ownerUserId, ownerUserId),
          eq(schema.documentVersions.contentHash, contentHash),
          isNull(schema.documents.deletedAt),
          notInArray(schema.documents.processingState, ["superseded", "deleted"]),
        ),
      )
      .orderBy(schema.documents.createdAt)
      .limit(1);
    return existing ?? null;
  }

  /** Owner-only fetch shared by every explicit state-transition action below
   * (verify/archive/unarchive/markSuperseded/linkToEntity/delete) — 404s a missing or already hard-deleted
   * document, 403s a non-owner, same shape as `assertOwnedDocument` above but returning the full row since
   * these actions all need to inspect (and branch on) the document's current `processingState`. */
  private async requireOwnedDocument(documentId: string, userId: string) {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    return doc;
  }

  async upload(params: {
    ownerUserId: string;
    householdId: string | null;
    title: string;
    documentType: DocumentType;
    mimeType: string;
    buffer: Buffer;
    // MAIL-004 "Attachment intelligence" — set only by IngestionService.processEmailAttachments, when this
    // upload is actually an email attachment rather than a user-initiated upload; links the resulting
    // documents row back to its source email for provenance (see the documents.ts schema column's own doc
    // comment). Every other caller omits it, leaving the column null exactly as it always was.
    sourceEventId?: string;
  }): Promise<{ documentId: string }> {
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
    // §28.13 magic-byte validation — the declared mimeType is just a client-controlled header; this checks
    // the actual bytes match what's claimed before the file goes anywhere near storage/OCR/scanning.
    if (!matchesFileSignature(params.buffer, params.mimeType)) {
      throw new BadRequestException({
        code: "FILE_CONTENT_MISMATCH",
        message: `This file's content doesn't look like a valid ${params.mimeType} file.`,
      });
    }
    // §28.13 "Protect against ... oversized ... PDF page counts ... excessive OCR work" — only ever
    // rejects on a clearly-high count (see approxPdfPageCount's own doc comment on why it can undercount
    // but never over-counts, so this never blocks a legitimate small PDF).
    if (params.mimeType === "application/pdf" && approxPdfPageCount(params.buffer) > MAX_PDF_PAGES) {
      throw new BadRequestException({
        code: "PDF_TOO_MANY_PAGES",
        message: `PDFs must be ${MAX_PDF_PAGES} pages or fewer.`,
      });
    }
    // Total-account cap, checked before scanning/storage so a rejected upload never touches ClamAV or S3.
    await this.entitlements.assertStorageQuota(params.ownerUserId, params.buffer.length);

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
    const documentId = generateId("document");
    const versionId = generateId("documentVersion");
    const blobKey = `documents/${params.ownerUserId}/${documentId}/v1`;

    // §40.3 Document state machine's "superseded" — automatic path: byte-identical content re-uploaded by
    // the same owner (a re-scanned receipt, a duplicate email attachment) is about as confident a
    // "these are the same document" signal as exists, so unlike the explicit `markSuperseded` action below
    // (for a document whose content actually changed), this never needs a separate user confirmation step.
    // Looked up before the new row exists, and only ever finds a document still in the live pipeline —
    // already-superseded/deleted rows are excluded so a chain of re-uploads always points every prior
    // version at the single newest one, not at whichever one happened to exist when this ran.
    const duplicateOfLiveDocument = await this.findLiveDuplicateByContentHash(params.ownerUserId, contentHash);

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
      sensitivity: HEALTH_DOCUMENT_TYPES.has(params.documentType) ? "highly_sensitive" : "sensitive",
      visibility: "private",
      // No explicit processingState here — defaults to "uploaded", which is now accurate: scanning (when
      // configured) already happened above, before this row exists at all.
      currentVersionId: versionId,
      sourceEventId: params.sourceEventId ?? null,
    });

    await this.storage.putObject(blobKey, params.buffer, params.mimeType);

    // text/plain needs no AI call — just a buffer read — so there's no "excessive work" to move off the
    // request thread for it; PDF/image transcription is the actual §28.13 concern (a full document sent to
    // an external vision API), and now runs in the background worker instead (see processOcr below).
    const isPlainText = params.mimeType === "text/plain";
    const ocrText = isPlainText ? params.buffer.toString("utf8").slice(0, 50_000) : null;
    const ocrConfidence = isPlainText ? 1 : null;

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

    if (duplicateOfLiveDocument) {
      await this.db
        .update(schema.documents)
        .set({ processingState: "superseded", supersededByDocumentId: documentId, updatedAt: new Date() })
        .where(eq(schema.documents.id, duplicateOfLiveDocument.id));
    }

    if (isPlainText) {
      await this.db.update(schema.documents).set({ processingState: "extracted", updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
    } else if (this.ai.isConfigured()) {
      // Left at its default "uploaded" processingState until the worker finishes — see processOcr.
      await this.queue.enqueueDocumentOcr({ documentId, versionId, blobKey, mimeType: params.mimeType });
    } else {
      await this.db.update(schema.documents).set({ processingState: "classified", updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
    }

    // §44.4 "Full text ... document title, OCR" — indexed immediately with whatever's known at upload time
    // (title always; OCR text too for the plain-text fast path above). When OCR instead runs in the
    // background worker (processOcr, below), that call re-upserts this same document once the real text is
    // ready — this row is never left permanently title-only.
    await this.searchIndex?.upsert({
      resourceType: "document",
      resourceId: documentId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      sensitivity: HEALTH_DOCUMENT_TYPES.has(params.documentType) ? "highly_sensitive" : "sensitive",
      title: params.title,
      bodyText: ocrText ?? "",
    });

    return { documentId };
  }

  /** Runs in the background worker (worker-main.ts's documentOcrWorker), not the upload request — see
   * §28.13's doc comment on queue-names.ts's DocumentOcrJobData for why. Re-fetches the already-stored
   * file rather than carrying its bytes through the job payload. */
  async processOcr(data: { documentId: string; versionId: string; blobKey: string; mimeType: string }): Promise<void> {
    const buffer = await this.storage.getObject(data.blobKey);
    let ocrText: string | null = null;
    let ocrConfidence: number | null = null;
    try {
      ocrText = await this.extractTextWithClaude(buffer, data.mimeType);
      ocrConfidence = ocrText ? 0.75 : null;
    } catch (err) {
      this.logger.warn(`OCR extraction failed for ${data.documentId}: ${String(err)}`);
    }

    await this.db.update(schema.documentVersions).set({ ocrText, ocrConfidence }).where(eq(schema.documentVersions.id, data.versionId));
    await this.db
      .update(schema.documents)
      .set({ processingState: ocrText ? "extracted" : "classified", updatedAt: new Date() })
      .where(eq(schema.documents.id, data.documentId));

    // §44.4 — the upload()-time upsert above only ever had a null bodyText for anything OCR'd here (PDF/
    // image), so this re-upsert is what actually makes a scanned receipt/manual/etc. findable by its
    // extracted text, not just its title.
    if (this.searchIndex) {
      const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, data.documentId)).limit(1);
      if (doc) {
        await this.searchIndex.upsert({
          resourceType: "document",
          resourceId: doc.id,
          ownerUserId: doc.ownerUserId,
          householdId: doc.householdId,
          sensitivity: doc.sensitivity as "standard" | "sensitive" | "highly_sensitive" | "secret",
          title: doc.title,
          bodyText: ocrText ?? "",
        });
      }
    }
  }

  /**
   * §MSG-001 "Share-message extraction" — a public entry point onto the exact same OCR model call
   * `processOcr` uses for a regular document upload, reused (not duplicated) so a shared screenshot's text
   * gets identically-good transcription rather than a parallel, lower-quality extraction path. Deliberately
   * synchronous (unlike processOcr, which runs in the background worker per §28.13's "excessive OCR work"
   * doc comment) — a single share-sheet screenshot is a small, bounded, user-initiated, one-at-a-time
   * request, not the arbitrary-PDF-page-count abuse surface that comment is about, so there's no proportionate
   * reason to add queue/worker latency to what the rest of the share-capture flow already resolves inline
   * (IngestionService.classifyAndRouteShareMessage, called right after this, is itself a synchronous request-
   * time AI call). Callers decide what to do with a `null` result (couldn't transcribe) themselves.
   */
  async transcribeSharedImage(buffer: Buffer, mimeType: string): Promise<string | null> {
    return this.extractTextWithClaude(buffer, mimeType);
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

  /**
   * `filter` (default `"active"`) is the §40.3 Document state machine's "archived"/"superseded" exclusion:
   * a document sitting in either of those overlay states is deliberately hidden from the default vault
   * view (it stays fully intact and reachable — nothing here deletes or hides it from `documentDetail`/
   * `signedUrl`) but shouldn't clutter the everyday list a user scrolls through. `"archived"`/`"superseded"`
   * surface exactly that one bucket (for the vault's "Archived"/"Superseded" filter views); `"all"` returns
   * every non-hard-deleted document regardless of processingState. Hard-deleted rows (`deletedAt` set) are
   * excluded under every filter value — there's no "show deleted" view in this module (see `delete`'s own
   * doc comment on why single-document deletion has no in-app undo).
   */
  /**
   * TIME-002 "Object history" — every document whose `linkedEntityIds` points at `resourceId`, scoped to
   * what this user is allowed to see. Restored alongside HistoryModule (both were lost in the 2026-09-03
   * main force-push; see 0065_restore_object_notes.sql).
   *
   * Filters in JS rather than with a JSONB containment operator because `linkedEntityIds` has no GIN index
   * — matching how `linkToEntity` already reads-modifies-writes the same column. Unlike the original, this
   * also excludes soft-deleted rows, consistent with every other read path in this service.
   */
  async listLinkedTo(userId: string, resourceId: string) {
    const ownerCondition = await this.ownerOrDelegatedHousehold(
      userId,
      schema.documents.ownerUserId,
      schema.documents.householdId,
      schema.documents.visibility,
    );
    const owned = await this.db
      .select()
      .from(schema.documents)
      .where(and(ownerCondition, isNull(schema.documents.deletedAt)));
    return owned.filter((d) => d.linkedEntityIds.includes(resourceId));
  }

  async list(userId: string, filter: DocumentListFilter = "active") {
    const grantedIds = await this.sharing.grantedResourceIds("document", userId);
    const accessCondition =
      grantedIds.length > 0
        ? or(
            await this.ownerOrDelegatedHousehold(userId, schema.documents.ownerUserId, schema.documents.householdId, schema.documents.visibility),
            inArray(schema.documents.id, grantedIds),
          )!
        : await this.ownerOrDelegatedHousehold(userId, schema.documents.ownerUserId, schema.documents.householdId, schema.documents.visibility);
    const conditions = [accessCondition, isNull(schema.documents.deletedAt)];
    if (filter === "active") conditions.push(notInArray(schema.documents.processingState, ["archived", "superseded"]));
    else if (filter === "archived") conditions.push(eq(schema.documents.processingState, "archived"));
    else if (filter === "superseded") conditions.push(eq(schema.documents.processingState, "superseded"));
    const docs = await this.db
      .select()
      .from(schema.documents)
      .where(and(...conditions));
    const sharingStates = await this.computeSharingStates(docs.map((d) => d.id));
    // The replacement document is often NOT in this same filtered `docs` list (e.g. the "superseded"
    // filter only loads superseded rows, but a document's replacement is normally still active) — found
    // live via the QA guide's own testing: the web UI was cross-referencing `supersededByDocumentId`
    // against the current page's already-filtered list and silently falling back to the raw id whenever
    // the replacement fell outside that filter. Resolved server-side here instead, via one extra batched
    // query, so the title is correct regardless of which filter tab is showing this row.
    const supersededByIds = [...new Set(docs.map((d) => d.supersededByDocumentId).filter((id): id is string => id !== null))];
    const supersededByTitles = new Map<string, string>();
    if (supersededByIds.length > 0) {
      const replacements = await this.db
        .select({ id: schema.documents.id, title: schema.documents.title })
        .from(schema.documents)
        .where(inArray(schema.documents.id, supersededByIds));
      for (const r of replacements) supersededByTitles.set(r.id, r.title);
    }
    return docs.map((d) => ({
      ...d,
      sharingState: sharingStates.get(d.id) ?? (d.visibility === "household" ? "household" : "private"),
      supersededByTitle: d.supersededByDocumentId ? (supersededByTitles.get(d.supersededByDocumentId) ?? null) : null,
    }));
  }

  /**
   * HH-002 "Each object shows a privacy badge: Private, Household, Selected People, Shared Link." Found
   * live: `documents.visibility` (the column every access-control read path actually filters on) is only
   * ever "private" or "household" — createResourceGrant/createShareLink insert rows into their own tables
   * but never touch `visibility`, so a document with an active grant or a live public share link still
   * reported `visibility: "private"` from `list()`/the DB, with nothing in the API response distinguishing
   * "nobody but me can see this" from "I shared this with 3 people" or "there's a public link to this
   * right now." The web UI had no privacy badge at all as a result (see documents/page.tsx before this
   * fix) — just an ad hoc "Share with {household}" toggle unrelated to grants/links.
   *
   * Deliberately computed here rather than written back onto `documents.visibility` — that column is a
   * real input to `ownerOrDelegatedHousehold`'s household-visibility access check (`ne(visibilityCol,
   * "private")`), and conflating "is this a household-shared doc" with "does it currently have direct
   * grants/links" would risk changing who household members can see, not just what badge renders.
   * Precedence (broadest-exposure wins, matching how a reasonable owner would want the badge to warn
   * them): an active public share link outranks direct grants, which outrank household visibility.
   */
  private async computeSharingStates(documentIds: string[]): Promise<Map<string, "household" | "selected_people" | "shared_link">> {
    const result = new Map<string, "household" | "selected_people" | "shared_link">();
    if (documentIds.length === 0) return result;

    const householdRows = await this.db
      .select({ id: schema.documents.id })
      .from(schema.documents)
      .where(and(inArray(schema.documents.id, documentIds), eq(schema.documents.visibility, "household")));
    for (const row of householdRows) result.set(row.id, "household");

    // Grant/link precedence (shared_link > selected_people) is SharingService.computeSharingStates's own
    // Map insertion order below; household is folded in above it since only documents (among today's
    // shareable resources) have a household-visibility concept distinct from a direct grant/link.
    for (const [id, state] of await this.sharing.computeSharingStates("document", documentIds)) result.set(id, state);

    return result;
  }

  /** Ownership check shared by every grant/share-link write below — mirrors the resource-agnostic
   * SharingService's own doc comment on who's responsible for verifying this before delegating. */
  private async assertOwnedDocument(documentId: string, ownerUserId: string): Promise<void> {
    const [doc] = await this.db.select({ ownerUserId: schema.documents.ownerUserId }).from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== ownerUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
  }

  /** Owner-only — sharing an object is a right of the owner, not a household-delegated caregiver (FAM-006
   * delegation is about viewing/managing someone else's whole household context, not re-sharing their
   * individual objects to a third party). The actual grant mechanics (grantee lookup, self-share
   * rejection, row insert) now live in SharingService — see its own doc comment. */
  async createResourceGrant(documentId: string, ownerUserId: string, granteeEmail: string, expiresInDays?: number): Promise<{ id: string }> {
    await this.assertOwnedDocument(documentId, ownerUserId);
    return this.sharing.createResourceGrant("document", documentId, ownerUserId, granteeEmail, expiresInDays);
  }

  async listResourceGrants(documentId: string, ownerUserId: string) {
    await this.assertOwnedDocument(documentId, ownerUserId);
    return this.sharing.listResourceGrants("document", documentId);
  }

  async revokeResourceGrant(grantId: string, ownerUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, ownerUserId);
  }

  /**
   * Phase 2 §52.2 "object sharing" (spec SHARE-002 "secure external link") — the document-specific gate
   * (sensitivity tier) stays here; the token/passcode mechanics themselves now live in SharingService.
   */
  async createShareLink(documentId: string, ownerUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    const [doc] = await this.db
      .select({ ownerUserId: schema.documents.ownerUserId, sensitivity: schema.documents.sensitivity })
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId))
      .limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== ownerUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    // HH-002 Permissions: "High-sensitivity categories can disallow public links." Found live: nothing
    // previously checked `sensitivity` here at all — a document tagged "highly_sensitive" or "secret" (the
    // two tiers above the "sensitive" default; see sensitivityTierEnum in packages/db/src/schema/common.ts)
    // could get an unauthenticated, internet-reachable link exactly like any other document. A direct
    // resource grant (createResourceGrant, above) stays unrestricted by sensitivity — it targets one named,
    // already-a-Veynlo-account recipient, not "anyone with the URL," which is the actual risk this rule is
    // guarding against.
    if (doc.sensitivity === "highly_sensitive" || doc.sensitivity === "secret") {
      throw new ForbiddenException({
        code: "SENSITIVITY_BLOCKS_PUBLIC_LINK",
        message: "This document's sensitivity level doesn't allow public share links. Share it directly with someone's Veynlo account instead.",
      });
    }
    return this.sharing.createShareLink("document", documentId, ownerUserId, dto);
  }

  async listShareLinks(documentId: string, ownerUserId: string) {
    await this.assertOwnedDocument(documentId, ownerUserId);
    return this.sharing.listShareLinks("document", documentId);
  }

  async revokeShareLink(linkId: string, ownerUserId: string): Promise<void> {
    return this.sharing.revokeShareLink(linkId, ownerUserId);
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAccessEvents(documentId: string, ownerUserId: string) {
    await this.assertOwnedDocument(documentId, ownerUserId);
    return this.sharing.listAccessEvents("document", documentId);
  }

  /**
   * Public, unauthenticated redemption content for a document share link — dispatched from
   * PublicShareService once SharingService.resolveShareLink has already validated the
   * token/passcode/revocation/expiry (see that method's own doc comment for the security reasoning; none
   * of it is repeated here). This method is deliberately dumb: given a document id already known to be
   * behind a live share link, fetch its current version and mint a signed URL, same as the old
   * `accessShareLink` did after resolving the token itself.
   */
  async publicShareContent(documentId: string): Promise<{ url: string; title: string }> {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc || doc.deletedAt || !doc.currentVersionId) {
      throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    }
    const [version] = await this.db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, doc.currentVersionId)).limit(1);
    if (!version) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    return { url: await this.storage.signedGetUrl(version.blobRef), title: doc.title };
  }

  /**
   * Phase 2 §52.2 "bulk management" surfaced this: `documents.deletedAt` has existed since this table was
   * created (same soft-delete shape as every other domain table) but nothing ever wrote to it or filtered
   * on it — there was no way for a user to delete a single document, individually or in bulk. Soft-delete
   * only (never removes the storage blob/version rows here) — the account-deletion and connection-data-
   * deletion workers are the only paths that ever hard-delete document content, by design (§45).
   *
   * §40.3 Document state machine's "deleted" — this now also writes `processingState: "deleted"` so that
   * value is a real, queryable fact rather than something only inferable from `deletedAt` being non-null.
   * Deliberately NOT given its own grace-period/scheduled-hard-delete machinery like
   * `IdentityService.requestDeletion`'s account-level flow (`scheduledDeletionAt` + a delayed destructive
   * job + `cancelDeletion`): that pattern exists specifically because account deletion is eventually
   * genuinely destructive and needs an undo window before it fires. A single document's delete here was
   * already, and remains, a soft delete with NO hard-delete path of its own at all outside the account/
   * connector-wide workers (see this doc comment's second sentence, unchanged) — there is nothing "in
   * flight" for a grace period to protect against, and no restore UI was asked for this round, so adding a
   * second timer/undo system here would duplicate identity.service.ts's existing one for a case that
   * doesn't share its actual risk (irreversible data loss). If document restore ever becomes a real
   * requirement, it belongs here as its own explicit feature, not bolted onto this narrower state-labeling
   * fix.
   */
  async delete(documentId: string, userId: string): Promise<void> {
    // Deliberately NOT `requireOwnedDocument` — that helper 404s once `deletedAt` is set (the right call
    // for every *other* action here, which shouldn't be operable on a deleted document at all), but this
    // method needs to see an already-deleted row to make the second call an idempotent no-op instead of a
    // confusing 404 on a delete button a user could plausibly double-click.
    const [doc] = await this.db
      .select({ ownerUserId: schema.documents.ownerUserId, processingState: schema.documents.processingState, deletedAt: schema.documents.deletedAt })
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId))
      .limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    if (doc.deletedAt) return; // idempotent — already deleted
    const from = doc.processingState as DocumentProcessingState;
    if (!isValidProcessingStateTransition(from, "deleted")) {
      throw new BadRequestException({ code: "INVALID_STATE_TRANSITION", message: `Can't delete a document that's currently "${from}".` });
    }
    await this.db.update(schema.documents).set({ deletedAt: new Date(), processingState: "deleted", updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /**
   * §40.3 Document state machine's "verified" (DEC-001 "confirm/correct state") — the document-specific
   * user-confirmation action this vault never had: a document sits at whatever processingState the
   * automatic pipeline left it in — an AI-extracted guess — until a person actually looks at it and
   * confirms it's correct. Idempotent (re-verifying an already-verified document is a no-op); refuses a
   * document that hasn't been through the pipeline at all yet ("uploaded") since there's nothing to confirm
   * before at least a classification exists, and refuses one that's archived/superseded/deleted (restore it
   * first — verifying a hidden/retired document would be a confusing, silently-reversed-later no-op).
   */
  async verify(documentId: string, userId: string): Promise<void> {
    const doc = await this.requireOwnedDocument(documentId, userId);
    const from = doc.processingState as DocumentProcessingState;
    if (from === "verified") return;
    if (from === "uploaded") {
      throw new BadRequestException({ code: "NOTHING_TO_VERIFY", message: "This document hasn't finished processing yet — there's nothing to confirm." });
    }
    if (!isValidProcessingStateTransition(from, "verified")) {
      throw new BadRequestException({ code: "INVALID_STATE_TRANSITION", message: `Can't verify a document that's currently "${from}". Unarchive it first.` });
    }
    await this.db.update(schema.documents).set({ processingState: "verified", verifiedAt: new Date(), updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /**
   * §40.3 Document state machine's "archived" — a user-initiated soft-hide distinct from `delete`,
   * mirroring this codebase's existing archive pattern for saved memories/lists (their own plain nullable
   * `archivedAt` columns — see resurfacing.service.ts/lists.service.ts): the document stays fully intact
   * and reachable (still downloadable, still shareable) but drops out of the default vault view (`list()`
   * above) until explicitly surfaced via the `filter: "archived"` view or restored with `unarchive`.
   * Snapshots the pre-archive `processingState` into `previousProcessingState` so `unarchive` can restore
   * the exact stage rather than guessing one back from other columns. Idempotent.
   */
  async archive(documentId: string, userId: string): Promise<void> {
    const doc = await this.requireOwnedDocument(documentId, userId);
    const from = doc.processingState as DocumentProcessingState;
    if (from === "archived") return;
    if (!isValidProcessingStateTransition(from, "archived")) {
      throw new BadRequestException({ code: "INVALID_STATE_TRANSITION", message: `Can't archive a document that's currently "${from}".` });
    }
    await this.db.update(schema.documents).set({ processingState: "archived", previousProcessingState: from, updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /** The `archive` reverse — restores whichever pipeline stage (or "superseded") the document actually was
   * in right before it was archived, computed from the `previousProcessingState` snapshot `archive` wrote,
   * never from client input; a bogus/missing snapshot falls back to "extracted" rather than leaving the
   * document stuck archived. */
  async unarchive(documentId: string, userId: string): Promise<void> {
    const doc = await this.requireOwnedDocument(documentId, userId);
    if (doc.processingState !== "archived") {
      throw new BadRequestException({ code: "NOT_ARCHIVED", message: "This document isn't archived." });
    }
    const snapshot = doc.previousProcessingState as DocumentProcessingState | null;
    const restoreTo = snapshot && isValidProcessingStateTransition("archived", snapshot) ? snapshot : "extracted";
    await this.db.update(schema.documents).set({ processingState: restoreTo, previousProcessingState: null, updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /**
   * §40.3 Document state machine's "superseded" (explicit path) — for a newer document that replaces an
   * older one but isn't byte-identical (a corrected invoice, an amended lease), so `upload()`'s automatic
   * exact-content-hash path never fires. Called on the OLD document with its replacement's id. Precision-
   * first per this feature's own brief: never guesses from filename similarity alone — on top of the
   * explicit action itself, requires the caller to own both documents and the two to share a real
   * relatedness signal (same documentType, an overlapping `linkedEntityIds` domain link, or a shared
   * `sourceEventId`), so a user can't accidentally (and an attacker can't maliciously) splice two unrelated
   * documents' lineage together just by knowing both ids.
   */
  async markSuperseded(documentId: string, userId: string, replacedByDocumentId: string): Promise<void> {
    if (documentId === replacedByDocumentId) {
      throw new BadRequestException({ code: "CANNOT_SUPERSEDE_SELF", message: "A document can't replace itself." });
    }
    const [oldDoc, newDoc] = await Promise.all([this.requireOwnedDocument(documentId, userId), this.requireOwnedDocument(replacedByDocumentId, userId)]);
    const from = oldDoc.processingState as DocumentProcessingState;
    if (from === "superseded" && oldDoc.supersededByDocumentId === replacedByDocumentId) return;
    if (!isValidProcessingStateTransition(from, "superseded")) {
      throw new BadRequestException({ code: "INVALID_STATE_TRANSITION", message: `Can't mark a document that's currently "${from}" as superseded.` });
    }
    const relatedByType = oldDoc.documentType === newDoc.documentType;
    const relatedByLink = oldDoc.linkedEntityIds.some((id) => newDoc.linkedEntityIds.includes(id));
    const relatedBySource = Boolean(oldDoc.sourceEventId) && oldDoc.sourceEventId === newDoc.sourceEventId;
    if (!relatedByType && !relatedByLink && !relatedBySource) {
      throw new BadRequestException({
        code: "NOT_CONFIDENTLY_RELATED",
        message: "These documents don't look related enough to link as a replacement — they must share a document type, a linked record, or a source event.",
      });
    }
    await this.db
      .update(schema.documents)
      .set({ processingState: "superseded", supersededByDocumentId: replacedByDocumentId, updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));
  }

  /**
   * §40.3 Document state machine's "linked" — a document becomes "linked" once it's actually associated
   * with a domain record (a receipt linked to a purchases row, a warranty linked to a warranties row, an
   * insurance card linked to a health appointment via HealthLogisticsService.linkDocumentToAppointment).
   * `linkedEntityIds` (packages/db/src/schema/documents.ts) is the schema's own pre-existing, generic,
   * many-to-many association column — HealthLogisticsService already writes it directly for its one
   * existing caller (a private, module-internal write, since `linkedEntityIds` is a plain column any
   * service in this codebase can already reach — not a gap this method needs to close), but never advanced
   * `processingState` to reflect it. This is the module-owned primitive that does both together; a future
   * round can point HealthLogisticsService (and any purchases/warranties-linking code) at this instead of
   * writing `linkedEntityIds` directly, but that's a cross-module change out of this round's scope (sole
   * ownership of `documents/` only). Idempotent; never regresses "linked"/"verified" back down, and never
   * touches processingState once a document is archived/superseded/deleted — linking metadata to a hidden/
   * retired document is still a legitimate, inert record, it just shouldn't silently resurrect its pipeline
   * stage.
   */
  async linkToEntity(documentId: string, userId: string, entityId: string): Promise<void> {
    const doc = await this.requireOwnedDocument(documentId, userId);
    const alreadyLinked = doc.linkedEntityIds.includes(entityId);
    const updates: { linkedEntityIds?: string[]; processingState?: DocumentProcessingState; updatedAt: Date } = { updatedAt: new Date() };
    if (!alreadyLinked) updates.linkedEntityIds = [...doc.linkedEntityIds, entityId];
    const from = doc.processingState as DocumentProcessingState;
    const fromIdx = DOCUMENT_PROCESSING_PIPELINE.indexOf(from);
    const linkedIdx = DOCUMENT_PROCESSING_PIPELINE.indexOf("linked");
    if (fromIdx !== -1 && fromIdx < linkedIdx) updates.processingState = "linked";
    if (alreadyLinked && updates.processingState === undefined) return; // nothing would actually change
    await this.db.update(schema.documents).set(updates).where(eq(schema.documents.id, documentId));
  }

  /** Bulk counterpart for the Documents page's multi-select — one bad/unowned id in the batch is
   * reported, not allowed to fail the rest (same posture as InboxService.bulkAction). */
  async bulkDelete(documentIds: string[], userId: string): Promise<{ succeeded: number; failed: string[] }> {
    let succeeded = 0;
    const failed: string[] = [];
    for (const id of documentIds) {
      try {
        await this.delete(id, userId);
        succeeded += 1;
      } catch {
        failed.push(id);
      }
    }
    return { succeeded, failed };
  }

  /**
   * Mobile documents-detail gap fix: the OCR'd text `documentVersions.ocrText` captures (see
   * `extractTextWithClaude` above) has been readable on the backend since the pipeline shipped, but no
   * endpoint ever returned it to a client — `list()` only returns document metadata, and `signedUrl()`
   * only mints a link to the raw file. Neither web nor mobile had a document detail screen as a result.
   * Reuses `signedUrl`'s exact access-check shape (owner, delegated/visible household member, or an
   * active resource grant) rather than duplicating it with different rules.
   */
  async documentDetail(documentId: string, userId: string) {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) {
      let householdAccess = false;
      // HLTH-002 — a health-tagged document (insurance card, EOB) never grants access via plain household
      // membership/delegation, even when visibility is "household" — see HEALTH_DOCUMENT_TYPES's own doc
      // comment. Only ownership (checked above) or an explicit resourceGrant (checked below) can reach it.
      if (doc.householdId && doc.visibility !== "private" && !HEALTH_DOCUMENT_TYPES.has(doc.documentType)) {
        const delegatedIds = await this.households.delegatedHouseholdIds(userId, "documents:read");
        householdAccess = delegatedIds.includes(doc.householdId) || (await this.households.isActiveMember(doc.householdId, userId));
      }
      if (!householdAccess && !(await this.sharing.hasActiveGrant("document", documentId, userId))) {
        throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
      }
    }
    let version: typeof schema.documentVersions.$inferSelect | null = null;
    if (doc.currentVersionId) {
      const rows = await this.db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, doc.currentVersionId)).limit(1);
      version = rows[0] ?? null;
    }
    const sharingState = (await this.computeSharingStates([doc.id])).get(doc.id) ?? (doc.visibility === "household" ? "household" : "private");
    // §40.3 "superseded" lineage, both directions — "replaces" (documents this one was explicitly/
    // automatically marked as the replacement for) and, when this document is itself superseded, which
    // document replaced it. Small, owner-scoped result set (a document's supersede chain in practice), so a
    // plain extra query beats denormalizing a reverse pointer onto the schema.
    const replaces = await this.db
      .select({ id: schema.documents.id, title: schema.documents.title })
      .from(schema.documents)
      .where(eq(schema.documents.supersededByDocumentId, doc.id));
    return {
      id: doc.id,
      title: doc.title,
      documentType: doc.documentType,
      processingState: doc.processingState,
      verifiedAt: doc.verifiedAt,
      supersededByDocumentId: doc.supersededByDocumentId,
      replaces: replaces.map((r) => ({ id: r.id, title: r.title })),
      isEmergencyBinderItem: doc.isEmergencyBinderItem,
      documentKind: doc.documentKind,
      expiresAt: doc.expiresAt,
      householdId: doc.householdId,
      createdAt: doc.createdAt,
      sharingState,
      version: version
        ? {
            mimeType: version.mimeType,
            sizeBytes: version.sizeBytes,
            ocrText: version.ocrText,
            ocrConfidence: version.ocrConfidence,
          }
        : null,
    };
  }

  async signedUrl(documentId: string, userId: string): Promise<string> {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) {
      let householdAccess = false;
      // HLTH-002 — a health-tagged document (insurance card, EOB) never grants access via plain household
      // membership/delegation, even when visibility is "household" — see HEALTH_DOCUMENT_TYPES's own doc
      // comment. Only ownership (checked above) or an explicit resourceGrant (checked below) can reach it.
      if (doc.householdId && doc.visibility !== "private" && !HEALTH_DOCUMENT_TYPES.has(doc.documentType)) {
        const delegatedIds = await this.households.delegatedHouseholdIds(userId, "documents:read");
        householdAccess = delegatedIds.includes(doc.householdId) || (await this.households.isActiveMember(doc.householdId, userId));
      }
      if (!householdAccess && !(await this.sharing.hasActiveGrant("document", documentId, userId))) {
        throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
      }
    }
    if (!doc.currentVersionId) throw new NotFoundException({ code: "NO_VERSION", message: "No file version available." });
    const [version] = await this.db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.id, doc.currentVersionId))
      .limit(1);
    if (!version) throw new NotFoundException({ code: "NO_VERSION", message: "No file version available." });
    return this.storage.signedGetUrl(version.blobRef);
  }

  /** Phase 2 §52.2 "emergency binder" — only the owner decides what goes in; see the schema column's own doc comment for why this is never inferred automatically. */
  async setEmergencyBinderItem(documentId: string, userId: string, isEmergencyBinderItem: boolean): Promise<void> {
    const [doc] = await this.db.select({ ownerUserId: schema.documents.ownerUserId, householdId: schema.documents.householdId }).from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    if (isEmergencyBinderItem && !doc.householdId) {
      throw new BadRequestException({ code: "HOUSEHOLD_REQUIRED", message: "Share this document with a household before adding it to the emergency binder." });
    }
    await this.db.update(schema.documents).set({ isEmergencyBinderItem, updatedAt: new Date() }).where(eq(schema.documents.id, documentId));
  }

  /** Phase 3 §26 TRIP-006 "Travel document readiness" — same owner-only-set posture as
   * setEmergencyBinderItem; see documents.ts's `documentKind`/`expiresAt` schema doc comment for why this
   * lives on the existing Documents vault rather than a new identity-document subsystem. */
  async setTravelInfo(documentId: string, userId: string, documentKind: string | null, expiresAtIso: string | null): Promise<void> {
    const [doc] = await this.db.select({ ownerUserId: schema.documents.ownerUserId }).from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    const expiresAt = expiresAtIso ? { precision: "date" as const, instantUtc: null, date: expiresAtIso.slice(0, 10), timezone: null, sourceText: null } : null;
    await this.db
      .update(schema.documents)
      .set({ documentKind, expiresAt, expiresAtSort: expiresAt?.date ? new Date(`${expiresAt.date}T00:00:00Z`) : null, updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));
  }

  /**
   * Found live while wiring the emergency binder: `upload()` has always hardcoded `householdId: null`, so
   * despite `documents.householdId` and `ownerOrDelegatedHousehold`'s household-visibility branch existing
   * in the schema/read-path since this table was created, nothing ever actually WROTE a non-null value —
   * household document sharing was dead on the write side the whole time. This is the missing write path.
   */
  async setHousehold(documentId: string, userId: string, householdId: string | null): Promise<void> {
    const [doc] = await this.db.select({ ownerUserId: schema.documents.ownerUserId, visibility: schema.documents.visibility }).from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    if (householdId) {
      const isMember = await this.households.isActiveMember(householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    const updates: { householdId: string | null; updatedAt: Date; isEmergencyBinderItem?: boolean; visibility?: "household" } = { householdId, updatedAt: new Date() };
    if (!householdId) {
      updates.isEmergencyBinderItem = false; // unsharing a document must pull it out of any binder it was in — a binder item with no household is unreachable and misleading to leave flagged
    } else if (doc.visibility === "private") {
      // Sharing to a household while leaving visibility "private" would be a self-contradicting state:
      // every household-visibility read path (ownerOrDelegatedHousehold, emergencyBinderItems) explicitly
      // excludes visibility:"private" rows even when householdId matches (FAM-006 — a member's explicitly
      // private document shouldn't leak to delegates just because a householdId happens to be set), so the
      // document would silently stay invisible to everyone but the owner despite the caller's clear intent.
      updates.visibility = "household";
    }
    await this.db.update(schema.documents).set(updates).where(eq(schema.documents.id, documentId));
  }

  /**
   * Any active household member can see the binder — a deliberately broader access rule than
   * `documents:read` delegation (that scope is for viewing someone's WHOLE document set; being in the same
   * household is enough for the small, explicitly-opted-in emergency subset). Only the household-linked
   * copy of an item is listed; a private, personal-only document a user flagged for their own reference
   * never appears here even to the owner via this endpoint (use the regular document list for that).
   */
  async emergencyBinderItems(householdId: string, userId: string) {
    const isMember = await this.households.isActiveMember(householdId, userId);
    if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of this household." });
    return this.db
      .select()
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.householdId, householdId),
          eq(schema.documents.isEmergencyBinderItem, true),
          ne(schema.documents.visibility, "private"),
          isNull(schema.documents.deletedAt),
        ),
      );
  }
}
