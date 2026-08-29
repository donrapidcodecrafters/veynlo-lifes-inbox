import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SavedItemsService } from "./saved-items.service";
import { CreateSavedItemDtoSchema, UpdateSavedItemDtoSchema, type CreateSavedItemDto, type UpdateSavedItemDto } from "./dto";

@Controller("v1/saved-items")
@UseGuards(AuthGuard)
export class SavedItemsController {
  constructor(private readonly savedItems: SavedItemsService) {}

  @Post()
  @UsePipes(new ZodValidationPipe(CreateSavedItemDtoSchema))
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSavedItemDto) {
    return this.savedItems.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("archived") archived?: string) {
    return this.savedItems.list(user.userId, { archived: archived === "true" ? true : archived === "false" ? false : undefined });
  }

  @Patch(":id")
  @UsePipes(new ZodValidationPipe(UpdateSavedItemDtoSchema))
  async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateSavedItemDto) {
    await this.savedItems.update(id, user.userId, dto);
    return { ok: true };
  }

  @Delete(":id")
  async delete(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.savedItems.delete(id, user.userId);
    return { ok: true };
  }
}
