import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
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
  "other",
]);

@Controller("v1/documents")
@UseGuards(AuthGuard)
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.documents.list(user.userId);
  }

  @Get(":id/download-url")
  async downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Query("versionId") versionId?: string) {
    return { url: await this.documents.signedUrl(id, user.userId, versionId) };
  }

  @Patch(":id")
  async updateMetadata(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { title?: string; documentType?: string; tags?: string[] },
  ) {
    if (body.documentType !== undefined && !VALID_DOCUMENT_TYPES.has(body.documentType)) {
      throw new BadRequestException({ code: "INVALID_DOCUMENT_TYPE", message: `${body.documentType} isn't a recognized document type.` });
    }
    await this.documents.updateMetadata(id, user.userId, { title: body.title, documentType: body.documentType as DocumentType | undefined, tags: body.tags });
    return { ok: true };
  }

  @Delete(":id")
  async deleteDocument(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.documents.deleteDocument(id, user.userId);
    return { ok: true };
  }

  @Post(":id/unlink")
  async unlink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("resourceId") resourceId: string) {
    if (!resourceId) throw new BadRequestException({ code: "RESOURCE_ID_REQUIRED", message: "resourceId is required." });
    await this.documents.unlinkResource(id, user.userId, resourceId);
    return { ok: true };
  }

  @Get(":id/versions")
  listVersions(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.documents.listVersions(id, user.userId);
  }

  @Post(":id/versions")
  async addVersion(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: FastifyRequest) {
    const file = await req.file();
    if (!file) throw new BadRequestException({ code: "NO_FILE", message: "No file was uploaded." });
    const buffer = await file.toBuffer();
    return this.documents.addVersion(id, user.userId, { mimeType: file.mimetype, buffer });
  }

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
    const linkedResourceIdField = file.fields.linkedResourceId;
    const linkedResourceId = linkedResourceIdField && "value" in linkedResourceIdField ? String(linkedResourceIdField.value) : undefined;

    const buffer = await file.toBuffer();
    return this.documents.upload({
      ownerUserId: user.userId,
      householdId: null,
      title,
      documentType,
      mimeType: file.mimetype,
      buffer,
      linkedResourceId,
    });
  }
}
