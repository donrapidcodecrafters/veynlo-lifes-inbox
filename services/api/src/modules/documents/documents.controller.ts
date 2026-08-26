import { BadRequestException, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
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
  async downloadUrl(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return { url: await this.documents.signedUrl(id, user.userId) };
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
