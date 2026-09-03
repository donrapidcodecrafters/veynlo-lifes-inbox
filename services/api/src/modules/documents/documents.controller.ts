import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req, UseGuards, UsePipes } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import {
  BulkDeleteDocumentsDtoSchema,
  type BulkDeleteDocumentsDto,
  SetDocumentTravelInfoDtoSchema,
  type SetDocumentTravelInfoDto,
  MarkSupersededDtoSchema,
  type MarkSupersededDto,
  LinkDocumentToEntityDtoSchema,
  type LinkDocumentToEntityDto,
  DocumentListFilterSchema,
} from "./dto";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { DocumentType } from "@veynlo/core";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { DocumentsService } from "./documents.service";

const VALID_DOCUMENT_TYPES = new Set([
  "receipt",
  "warranty",
  "insurance_policy",
  "contract",
  "manual",
  "tax_document",
  "registration",
  "title",
  "identity_document",
  "membership_document",
  "statement",
  "invitation",
  // HLTH-002 "insurance card/document vault" — see DocumentsService's HEALTH_DOCUMENT_TYPES doc comment.
  "insurance_card",
  "eob",
  "other",
]);

@Controller("v1/documents")
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  /** `?filter=active|archived|superseded|all` — see DocumentsService.list's own doc comment. An
   * unrecognized/omitted value falls back to "active", the default every existing caller already expects. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("filter") filter?: string) {
    const parsed = DocumentListFilterSchema.safeParse(filter);
    return this.documents.list(user.userId, parsed.success ? parsed.data : "active");
  }

  /** Mobile/web documents-detail gap fix — see DocumentsService.documentDetail's own doc comment. */
  @Get(":id")
  documentDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.documents.documentDetail(id, user.userId);
  }

  @Get(":id/download-url")
  async downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return { url: await this.documents.signedUrl(id, user.userId) };
  }

  // A different HTTP method than the `:id` DELETE below, so no route-ordering hazard here (unlike
  // attention.controller.ts's bulk routes, which share POST with their own `:id`-shaped routes).
  @Post("bulk/delete")
  @UsePipes(new ZodValidationPipe(BulkDeleteDocumentsDtoSchema))
  bulkDelete(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkDeleteDocumentsDto) {
    return this.documents.bulkDelete(dto.ids, user.userId);
  }

  @Delete(":id")
  async deleteDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.documents.delete(id, user.userId);
    return { success: true };
  }

  /** §40.3 Document state machine's "verified" — see DocumentsService.verify's own doc comment. */
  @Put(":id/verify")
  async verifyDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.documents.verify(id, user.userId);
    return { success: true };
  }

  /** §40.3 Document state machine's "archived" — see DocumentsService.archive's own doc comment. */
  @Put(":id/archive")
  async archiveDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.documents.archive(id, user.userId);
    return { success: true };
  }

  @Put(":id/unarchive")
  async unarchiveDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.documents.unarchive(id, user.userId);
    return { success: true };
  }

  /** §40.3 Document state machine's "superseded" (explicit path) — see DocumentsService.markSuperseded's
   * own doc comment. Called on the OLD document with its replacement's id. */
  @Put(":id/supersede")
  @UsePipes(new ZodValidationPipe(MarkSupersededDtoSchema))
  async supersedeDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MarkSupersededDto) {
    await this.documents.markSuperseded(id, user.userId, dto.replacedByDocumentId);
    return { success: true };
  }

  /** §40.3 Document state machine's "linked" — see DocumentsService.linkToEntity's own doc comment. */
  @Put(":id/link")
  @UsePipes(new ZodValidationPipe(LinkDocumentToEntityDtoSchema))
  async linkDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: LinkDocumentToEntityDto) {
    await this.documents.linkToEntity(id, user.userId, dto.entityId);
    return { success: true };
  }

  /** Found live while wiring the emergency binder — see DocumentsService.setHousehold's own doc comment: this was previously entirely dead on the write side. */
  @Put(":id/household")
  async setHousehold(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("householdId") householdId: string | null) {
    await this.documents.setHousehold(id, user.userId, householdId ?? null);
    return { success: true };
  }

  @Put(":id/emergency-binder")
  async setEmergencyBinderItem(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("isEmergencyBinderItem") isEmergencyBinderItem: boolean) {
    await this.documents.setEmergencyBinderItem(id, user.userId, Boolean(isEmergencyBinderItem));
    return { success: true };
  }

  /** Phase 3 §26 TRIP-006 "Travel document readiness" — see SetDocumentTravelInfoDtoSchema's own doc comment. */
  @Put(":id/travel-info")
  @UsePipes(new ZodValidationPipe(SetDocumentTravelInfoDtoSchema))
  async setTravelInfo(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetDocumentTravelInfoDto) {
    await this.documents.setTravelInfo(id, user.userId, dto.documentKind, dto.expiresAtIso);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — grants directly to another account,
  // and passcode-/expiry-gated public links. Both scoped under literal "grants"/"share-links" segments,
  // a different path depth than the `:id`-shaped routes above, so there's no route-ordering hazard.
  @Post(":id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.documents.createResourceGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays);
  }

  @Get(":id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.documents.listResourceGrants(id, user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.documents.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post(":id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.documents.createShareLink(id, user.userId, dto);
  }

  @Get(":id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.documents.listShareLinks(id, user.userId);
  }

  @Delete("share-links/:linkId")
  async revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.documents.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get(":id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.documents.listAccessEvents(id, user.userId);
  }

  /** Phase 2 §52.2 "emergency binder" — lives under /v1/documents (not /v1/households) to avoid a module import cycle: DocumentsModule already imports HouseholdModule for FAM-006 delegation checks. */
  @Get("emergency-binder/:householdId")
  emergencyBinder(@CurrentUser() user: AuthenticatedUser, @Param("householdId") householdId: string) {
    return this.documents.emergencyBinderItems(householdId, user.userId);
  }

  // §28.8/§28.16 "per-user quotas for ... upload" — the 25MB-per-file cap and the total-storage
  // entitlement quota (EntitlementsService.assertStorageQuota) bound size and cumulative footprint, but
  // neither bounds request *rate*: without this, an attacker under both caps could still fire uploads
  // fast enough to burn CPU on malware scanning/OCR far beyond the global 300/min default. Same tier as
  // ingestion's manual/URL capture, which has the identical cost shape (a write plus optional AI work).
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("upload")
  async upload(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException({ code: "NO_FILE", message: "No file was uploaded." });

    const documentTypeField = file.fields.documentType;
    const documentType =
      documentTypeField && "value" in documentTypeField && VALID_DOCUMENT_TYPES.has(String(documentTypeField.value))
        ? (String(documentTypeField.value) as DocumentType)
        : ("other" as DocumentType);
    const titleField = file.fields.title;
    const title = titleField && "value" in titleField ? String(titleField.value) : file.filename;

    const buffer = await file.toBuffer();
    return this.documents.upload({
      ownerUserId: user.userId,
      householdId: null,
      title,
      documentType,
      mimeType: file.mimetype,
      buffer,
    });
  }
}
