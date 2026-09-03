import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto } from "../sharing/dto";
import { IdentityRecordsService } from "./identity-records.service";
import {
  CreateIdentityRecordDtoSchema,
  type CreateIdentityRecordDto,
  UpdateIdentityRecordDtoSchema,
  type UpdateIdentityRecordDto,
  RenewIdentityRecordDtoSchema,
  type RenewIdentityRecordDto,
  RevealDocumentNumberDtoSchema,
  type RevealDocumentNumberDto,
  LinkIdentityDocumentDtoSchema,
  type LinkIdentityDocumentDto,
  SetJurisdictionLinkDtoSchema,
  type SetJurisdictionLinkDto,
} from "./dto";

/** "Identity & Legal Continuity" (ID-001..005) — see IdentityRecordsService's own doc comment for the
 * access-control model this controller is a thin HTTP wrapper over. */
@Controller("v1/identity-records")
@UseGuards(AuthGuard)
export class IdentityRecordsController {
  constructor(@Inject(IdentityRecordsService) private readonly records: IdentityRecordsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.records.list(user.userId);
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.records.detail(id, user.userId);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(CreateIdentityRecordDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateIdentityRecordDto) {
    return this.records.create(user.userId, dto);
  }

  // RET-004-shaped user correction to the curated jurisdiction-renewal-link registry — not scoped to one
  // record (corrects the (recordType, jurisdiction) pair itself). MUST be registered before the "PUT :id"
  // handler below: both are PUT and Nest/Express match route handlers in registration order, so a dynamic
  // ":id" segment registered first would otherwise greedily swallow the literal path
  // "/v1/identity-records/jurisdiction-links" as if "jurisdiction-links" were an `:id` value, and this
  // handler would never be reached.
  @Put("jurisdiction-links")
  @UsePipes(new ZodValidationPipe(SetJurisdictionLinkDtoSchema))
  setJurisdictionLink(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetJurisdictionLinkDto) {
    return this.records.setJurisdictionLink(user.userId, dto);
  }

  @Put(":id")
  @UsePipes(new ZodValidationPipe(UpdateIdentityRecordDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateIdentityRecordDto) {
    await this.records.update(id, user.userId, dto);
    return { success: true };
  }

  @Delete(":id")
  async delete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.records.delete(id, user.userId);
    return { success: true };
  }

  @Post(":id/renew")
  @UsePipes(new ZodValidationPipe(RenewIdentityRecordDtoSchema))
  renew(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: RenewIdentityRecordDto) {
    return this.records.renewRecord(id, user.userId, dto);
  }

  // §28.9 step-up gate — "reveal/copy protected field." Same PASSWORD_REQUIRED/INVALID_CREDENTIALS error
  // shape as every other step-up action in this app.
  @Post(":id/reveal-document-number")
  @UsePipes(new ZodValidationPipe(RevealDocumentNumberDtoSchema))
  reveal(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: RevealDocumentNumberDto) {
    return this.records.revealDocumentNumber(id, user.userId, dto.password);
  }

  @Post(":id/link-document")
  @UsePipes(new ZodValidationPipe(LinkIdentityDocumentDtoSchema))
  async linkDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: LinkIdentityDocumentDto) {
    await this.records.linkDocument(id, user.userId, dto.documentId);
    return { success: true };
  }

  @Post(":id/unlink-document")
  async unlinkDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.records.unlinkDocument(id, user.userId);
    return { success: true };
  }

  @Post(":id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.records.createRecordGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays);
  }

  @Get(":id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.records.listRecordGrants(id, user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.records.revokeRecordGrant(grantId, user.userId);
    return { success: true };
  }

  @Post(":id/share-links")
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.records.createRecordShareLink(id, user.userId);
  }

  @Get(":id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.records.listRecordShareLinks(id, user.userId);
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant (identity records never
   * offer a public link — see createRecordShareLink's own doc comment). */
  @Get(":id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.records.listAccessEvents(id, user.userId);
  }
}
