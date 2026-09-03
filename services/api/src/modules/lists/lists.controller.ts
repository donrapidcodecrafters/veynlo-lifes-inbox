import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ListsService } from "./lists.service";
import {
  CreateListDtoSchema,
  CreateSavedItemDtoSchema,
  UpdateListDtoSchema,
  UpdateSavedItemDtoSchema,
  type CreateListDto,
  type CreateSavedItemDto,
  type UpdateListDto,
  type UpdateSavedItemDto,
} from "./dto";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";

@Controller("v1/lists")
@UseGuards(AuthGuard)
export class ListsController {
  constructor(@Inject(ListsService) private readonly lists: ListsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.lists.listLists(user.userId);
  }

  @Post()
  @UsePipes(new ZodValidationPipe(CreateListDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateListDto) {
    return this.lists.createList(user.userId, dto);
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.lists.listDetail(id, user.userId);
  }

  @Put(":id")
  @UsePipes(new ZodValidationPipe(UpdateListDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateListDto) {
    await this.lists.updateList(id, user.userId, dto);
    return { success: true };
  }

  @Delete(":id")
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.lists.deleteList(id, user.userId);
    return { success: true };
  }

  @Post(":id/items")
  @UsePipes(new ZodValidationPipe(CreateSavedItemDtoSchema))
  addItem(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateSavedItemDto) {
    return this.lists.addItem(id, user.userId, dto);
  }

  @Put("items/:itemId")
  @UsePipes(new ZodValidationPipe(UpdateSavedItemDtoSchema))
  async updateItem(@CurrentUser() user: AuthenticatedUser, @Param("itemId") itemId: string, @Body() dto: UpdateSavedItemDto) {
    await this.lists.updateItem(itemId, user.userId, dto);
    return { success: true };
  }

  @Delete("items/:itemId")
  async removeItem(@CurrentUser() user: AuthenticatedUser, @Param("itemId") itemId: string) {
    await this.lists.deleteItem(itemId, user.userId);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — mirrors documents.controller.ts's
  // grants/share-links routes exactly, generalized via SharingService.
  @Post(":id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.lists.createResourceGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays, dto.right, dto.message);
  }

  @Get(":id/grants")
  listGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.lists.listResourceGrants(id, user.userId);
  }

  // SHARE-001 "preview exactly what recipient will see" — an authenticated, owner/manager-only peek at
  // the same redacted content a public link recipient (or eventually the DEDICATED preview UI) gets.
  @Get(":id/share-preview")
  sharePreview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.lists.sharePreview(id, user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.lists.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post(":id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.lists.createShareLink(id, user.userId, dto);
  }

  @Get(":id/share-links")
  listShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.lists.listShareLinks(id, user.userId);
  }

  @Delete("share-links/:linkId")
  async revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.lists.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get(":id/access-log")
  listAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.lists.listAccessEvents(id, user.userId);
  }
}
