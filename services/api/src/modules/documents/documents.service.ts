import { createHash } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { generateId, type DocumentType } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";
import { StorageService } from "./storage.service";

const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "text/plain"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB — generous for scanned receipts/manuals, bounded against abuse

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly ai: AnthropicExtractionService,
  ) {}

  async upload(params: {
    ownerUserId: string;
    householdId: string | null;
    title: string;
    documentType: DocumentType;
    mimeType: string;
    buffer: Buffer;
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
      sensitivity: "sensitive",
      visibility: "private",
      processingState: "malware_scan",
      currentVersionId: versionId,
    });

    // Real malware scanning is a deployment-time integration point (e.g. ClamAV sidecar or a cloud AV API);
    // until that's wired, uploads are still MIME/size/hash validated above rather than trusted blindly.
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
      // Claude's vision input only accepts jpeg/png/gif/webp; HEIC needs a real transcode step (e.g. `sharp`)
      // before it can be sent — not yet wired, so we honestly skip OCR rather than send mislabeled bytes.
      return null;
    }
    if (mimeType.startsWith("image/")) {
      const supportedMediaType = mimeType as "image/jpeg" | "image/png";
      const result = await this.ai.extractStructured({
        extractorName: "document_ocr_image_v1",
        model: "cheap",
        systemPrompt: "Transcribe all readable text from this image verbatim. If unreadable, say so.",
        userContent: [
          { type: "image", source: { type: "base64", media_type: supportedMediaType, data: buffer.toString("base64") } },
          { type: "text", text: "Transcribe this image." },
        ],
        schema: z.object({ transcribedText: z.string() }),
        toolDescription: "Emit the transcribed image text.",
      });
      return result?.data.transcribedText ?? null;
    }
    return null;
  }

  async list(userId: string) {
    return this.db.select().from(schema.documents).where(eq(schema.documents.ownerUserId, userId));
  }

  async signedUrl(documentId: string, userId: string): Promise<string> {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    if (!doc.currentVersionId) throw new NotFoundException({ code: "NO_VERSION", message: "No file version available." });
    const [version] = await this.db
      .select()
      .from(schema.documentVersions)
      .where(eq(schema.documentVersions.id, doc.currentVersionId))
      .limit(1);
    if (!version) throw new NotFoundException({ code: "NO_VERSION", message: "No file version available." });
    return this.storage.signedGetUrl(version.blobRef);
  }
}
