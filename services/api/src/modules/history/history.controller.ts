import { Body, Controller, Get, Param, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { HistoryService } from "./history.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AddHistoryNoteDtoSchema, type AddHistoryNoteDto } from "./dto";

@Controller("v1/history")
@UseGuards(AuthGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get(":resourceType/:resourceId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("resourceType") resourceType: string, @Param("resourceId") resourceId: string) {
    return this.history.getHistory(user.userId, resourceType, resourceId);
  }

  @Post(":resourceType/:resourceId/notes")
  @UsePipes(new ZodValidationPipe(AddHistoryNoteDtoSchema))
  addNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param("resourceType") resourceType: string,
    @Param("resourceId") resourceId: string,
    @Body() dto: AddHistoryNoteDto,
  ) {
    return this.history.addNote(user.userId, resourceType, resourceId, dto.noteText);
  }
}
