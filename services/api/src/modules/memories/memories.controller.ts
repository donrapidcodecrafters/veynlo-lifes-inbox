import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import type { DocumentType } from "@veynlo/core";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";
import { DocumentsService } from "../documents/documents.service";
import { MemoriesService } from "./memories.service";
import {
  CreateMemoryDtoSchema,
  type CreateMemoryDto,
  UpdateMemoryDtoSchema,
  type UpdateMemoryDto,
  PromoteMemoryDtoSchema,
  type PromoteMemoryDto,
  CreateResurfacingRuleDtoSchema,
  type CreateResurfacingRuleDto,
  MEMORY_SOURCE_KINDS,
} from "./dto";

const UPLOADABLE_SOURCE_KINDS = new Set(["screenshot", "image", "document"]);

@Controller("v1/memories")
@UseGuards(AuthGuard)
export class MemoriesController {
  constructor(
    @Inject(MemoriesService) private readonly memories: MemoriesService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("category") category?: string, @Query("archived") archived?: string) {
    return this.memories.list(user.userId, { category: category || undefined, archived: archived === "true" });
  }

  // Declared before the `:id`-shaped routes below so "search" is never matched as an `:id` value —
  // same route-ordering discipline as documents.controller.ts's bulk routes.
  @Get("search")
  search(@CurrentUser() user: AuthenticatedUser, @Query("q") q: string) {
    return this.memories.search(user.userId, q ?? "");
  }

  @Post()
  @UsePipes(new ZodValidationPipe(CreateMemoryDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateMemoryDto) {
    return this.memories.create(user.userId, dto);
  }

  // §28.8/§28.16 per-user rate limiting — same tier as documents.controller.ts's upload route (a write
  // plus optional AI work), since a screenshot/image/document save goes through the identical
  // scan-then-store path.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("upload")
  async upload(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException({ code: "NO_FILE", message: "No file was uploaded." });

    const sourceKindField = file.fields.sourceKind;
    const sourceKindRaw = sourceKindField && "value" in sourceKindField ? String(sourceKindField.value) : "image";
    const sourceKind = (UPLOADABLE_SOURCE_KINDS.has(sourceKindRaw) ? sourceKindRaw : "image") as "screenshot" | "image" | "document";
    const titleField = file.fields.title;
    const title = titleField && "value" in titleField ? String(titleField.value) : undefined;
    const notesField = file.fields.userNotes;
    const userNotes = notesField && "value" in notesField ? String(notesField.value) : undefined;

    const buffer = await file.toBuffer();
    // Reuses the EXISTING Documents/object-storage pipeline for the actual bytes (§29.1 "reuse... don't
    // build parallel file storage") — documentType "other" since a saved screenshot/image/document isn't
    // any of DocumentsService's life-admin categories (receipt/warranty/etc.); this endpoint then only
    // creates the memory row pointing at the resulting document.
    const { documentId } = await this.documents.upload({
      ownerUserId: user.userId,
      householdId: null,
      title: title ?? file.filename,
      documentType: "other" as DocumentType,
      mimeType: file.mimetype,
      buffer,
    });
    return this.memories.createFromUpload(user.userId, documentId, { sourceKind, title, userNotes });
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.memories.detail(id, user.userId);
  }

  @Put(":id")
  @UsePipes(new ZodValidationPipe(UpdateMemoryDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateMemoryDto) {
    await this.memories.update(id, user.userId, dto);
    return { success: true };
  }

  @Delete(":id")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.memories.delete(id, user.userId);
    return { success: true };
  }

  @Post(":id/promote")
  @UsePipes(new ZodValidationPipe(PromoteMemoryDtoSchema))
  async promote(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: PromoteMemoryDto) {
    await this.memories.promote(id, user.userId, dto);
    return { success: true };
  }

  @Post(":id/resurfacing-rules")
  @UsePipes(new ZodValidationPipe(CreateResurfacingRuleDtoSchema))
  createResurfacingRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResurfacingRuleDto) {
    return this.memories.requestResurfacingRule(id, user.userId, dto);
  }

  @Get(":id/resurfacing-rules")
  listResurfacingRules(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.memories.listResurfacingRules(id, user.userId);
  }

  @Delete("resurfacing-rules/:ruleId")
  async deleteResurfacingRule(@CurrentUser() user: AuthenticatedUser, @Param("ruleId") ruleId: string) {
    await this.memories.deleteResurfacingRule(ruleId, user.userId);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — mirrors documents.controller.ts/
  // lists.controller.ts's identical routes, generalized via SharingService.
  @Post(":id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.memories.createResourceGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays);
  }

  @Get(":id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.memories.listResourceGrants(id, user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.memories.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post(":id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.memories.createShareLink(id, user.userId, dto);
  }

  @Get(":id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.memories.listShareLinks(id, user.userId);
  }

  @Delete("share-links/:linkId")
  async revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.memories.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get(":id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.memories.listAccessEvents(id, user.userId);
  }
}

// Re-exported so the web/mobile clients can validate against the same source-kind list without importing
// zod directly.
export { MEMORY_SOURCE_KINDS };
