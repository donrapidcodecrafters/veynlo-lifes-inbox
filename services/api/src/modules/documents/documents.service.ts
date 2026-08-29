import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import heicConvert from "heic-convert";
import { generateId, type DocumentType } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";
import { HouseholdService } from "../household/household.service";
import { StorageService } from "./storage.service";
import { MalwareScannerService } from "./malware-scanner.service";

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "text/plain"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — generous for scanned receipts/manuals, bounded against abuse

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly ai: AnthropicExtractionService,
    private readonly malwareScanner: MalwareScannerService,
    private readonly households: HouseholdService,
  ) {}

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

  async upload(params: {
    ownerUserId: string;
    householdId: string | null;
    title: string;
    documentType: DocumentType;
    mimeType: string;
    buffer: Buffer;
    /** TIME-002 "attach document" — an opaque `resourceId`, self-describing via its own generateId prefix (same "opaque, prefixed resource IDs" design already used everywhere else), not a separate resourceType column. */
    linkedResourceId?: string;
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
      .set({ processingState: ocrText ? "extracted" : "classified", updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));

    return { documentId };
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

  async list(userId: string) {
    return this.db
      .select()
      .from(schema.documents)
      .where(await this.ownerOrDelegatedHousehold(userId, schema.documents.ownerUserId, schema.documents.householdId, schema.documents.visibility));
  }

  /** TIME-002 "Object history" — documents attached to one specific resource (e.g. a purchase's receipt scan). */
  async listLinkedTo(userId: string, resourceId: string) {
    const owned = await this.list(userId);
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
    await this.assertOwnedDocument(documentId, userId);
    const patch: Partial<typeof schema.documents.$inferInsert> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.documentType !== undefined) patch.documentType = dto.documentType;
    if (dto.tags !== undefined) patch.tags = dto.tags;
    await this.db.update(schema.documents).set(patch).where(eq(schema.documents.id, documentId));
  }

  /** DOC-006 "link/unlink object" — the other half of TIME-002's "attach document" (linking happens at upload time via `linkedResourceId`). */
  async unlinkResource(documentId: string, userId: string, resourceId: string) {
    const doc = await this.assertOwnedDocument(documentId, userId);
    await this.db
      .update(schema.documents)
      .set({ linkedEntityIds: doc.linkedEntityIds.filter((id) => id !== resourceId), updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));
  }

  /** DOC-001/DOC-006 "delete" — no delete endpoint existed at all before this. Removes every version's blob from storage before the DB row (cascades to document_versions), so nothing orphaned is left in the bucket. */
  async deleteDocument(documentId: string, userId: string) {
    await this.assertOwnedDocument(documentId, userId);
    const versions = await this.db.select({ blobRef: schema.documentVersions.blobRef }).from(schema.documentVersions).where(eq(schema.documentVersions.documentId, documentId));
    for (const version of versions) await this.storage.deleteObject(version.blobRef).catch(() => undefined);
    await this.db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  }

  /**
   * DOC-004 "versioning" — previously every upload created a brand-new `documents` row; `document_versions`
   * was 1:1 in practice (schema/name only). This is the first real writer of a SECOND version against an
   * EXISTING document: same scan/storage/OCR pipeline as `upload()`, but targeting `documentId` and
   * incrementing `versionNumber` instead of always starting a fresh document.
   */
  async addVersion(documentId: string, userId: string, params: { mimeType: string; buffer: Buffer }): Promise<{ versionId: string }> {
    await this.assertOwnedDocument(documentId, userId);
    if (params.buffer.length === 0) throw new BadRequestException({ code: "EMPTY_FILE", message: "The uploaded file is empty." });
    if (params.buffer.length > MAX_UPLOAD_BYTES) throw new BadRequestException({ code: "FILE_TOO_LARGE", message: "Files must be 25MB or smaller." });
    if (!ALLOWED_MIME_TYPES.has(params.mimeType)) {
      throw new BadRequestException({ code: "UNSUPPORTED_FILE_TYPE", message: `${params.mimeType} isn't supported yet. Try PDF, JPG, PNG, HEIC, or plain text.` });
    }
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
      .set({ currentVersionId: versionId, processingState: ocrText ? "extracted" : "classified", updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));

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

  private async assertOwnedDocument(documentId: string, userId: string) {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) {
      const householdIds =
        doc.householdId && doc.visibility !== "private" ? await this.households.delegatedHouseholdIds(userId, "documents:read") : [];
      if (!doc.householdId || !householdIds.includes(doc.householdId)) {
        throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
      }
    }
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
