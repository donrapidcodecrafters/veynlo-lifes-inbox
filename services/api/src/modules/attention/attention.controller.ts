import { Body, Controller, Get, Param, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AttentionService } from "./attention.service";
import { InboxService } from "./inbox.service";
import {
  CorrectInboxItemDtoSchema,
  type CorrectInboxItemDto,
  SnoozeAttentionItemDtoSchema,
  type SnoozeAttentionItemDto,
  DelegateAttentionItemDtoSchema,
  type DelegateAttentionItemDto,
} from "./dto";

@Controller()
@UseGuards(AuthGuard)
export class AttentionController {
  constructor(
    private readonly attention: AttentionService,
    private readonly inbox: InboxService,
  ) {}

  @Get("v1/home")
  home(@CurrentUser() user: AuthenticatedUser) {
    return this.attention.home(user.userId);
  }

  @Get("v1/home/today")
  today(@CurrentUser() user: AuthenticatedUser) {
    return this.attention.today(user.userId);
  }

  @Get("v1/home/coming-up")
  comingUp(@CurrentUser() user: AuthenticatedUser) {
    return this.attention.comingUp(user.userId);
  }

  @Get("v1/home/money-at-risk")
  moneyAtRisk(@CurrentUser() user: AuthenticatedUser) {
    return this.attention.moneyAtRisk(user.userId);
  }

  @Post("v1/attention/:id/resolve")
  resolve(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.attention.resolve(id, user.userId);
  }

  @Post("v1/attention/:id/dismiss")
  dismiss(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("reason") reason?: string) {
    return this.attention.dismiss(id, user.userId, reason ?? "not_relevant");
  }

  @Post("v1/attention/:id/snooze")
  @UsePipes(new ZodValidationPipe(SnoozeAttentionItemDtoSchema))
  snoozeAttention(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SnoozeAttentionItemDto) {
    return this.attention.snooze(id, user.userId, new Date(dto.until));
  }

  @Post("v1/attention/:id/delegate")
  @UsePipes(new ZodValidationPipe(DelegateAttentionItemDtoSchema))
  delegate(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: DelegateAttentionItemDto) {
    return this.attention.delegate(id, user.userId, dto.assigneeUserId);
  }

  @Post("v1/attention/:id/share")
  share(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.attention.createShareLink(id, user.userId);
  }

  @Post("v1/attention/:id/share/revoke")
  revokeShare(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.attention.revokeShareLinks(id, user.userId);
  }

  @Get("v1/inbox")
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("reviewState") reviewState?: string,
    @Query("category") category?: string,
    @Query("autoFiled") autoFiled?: string,
    @Query("confidenceBand") confidenceBand?: string,
    @Query("isDuplicate") isDuplicate?: string,
    @Query("before") before?: string,
  ) {
    return this.inbox.list(user.userId, {
      reviewState,
      category,
      autoFiled: autoFiled === undefined ? undefined : autoFiled === "true",
      confidenceBand,
      isDuplicate: isDuplicate === undefined ? undefined : isDuplicate === "true",
      before,
    });
  }

  @Get("v1/inbox/:id/source")
  inspectSource(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.inspectSource(id, user.userId);
  }

  @Post("v1/inbox/:id/block-sender")
  blockSender(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.blockSender(id, user.userId);
  }

  @Post("v1/inbox/:id/sender-rule")
  setSenderCategoryRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("category") category: string) {
    return this.inbox.setSenderCategoryRule(id, user.userId, category);
  }

  @Get("v1/inbox/sender-rules")
  listSenderRules(@CurrentUser() user: AuthenticatedUser) {
    return this.inbox.listSenderRules(user.userId);
  }

  @Post("v1/inbox/sender-rules/:ruleId/delete")
  deleteSenderRule(@CurrentUser() user: AuthenticatedUser, @Param("ruleId") ruleId: string) {
    return this.inbox.deleteSenderRule(ruleId, user.userId);
  }

  @Post("v1/inbox/:id/confirm")
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.confirm(id, user.userId);
  }

  @Post("v1/inbox/:id/correct")
  @UsePipes(new ZodValidationPipe(CorrectInboxItemDtoSchema))
  correct(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CorrectInboxItemDto) {
    return this.inbox.correct(id, user.userId, dto);
  }

  @Post("v1/inbox/:id/archive")
  archive(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.archive(id, user.userId);
  }

  @Post("v1/inbox/:id/dismiss")
  dismissInbox(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.dismiss(id, user.userId);
  }

  @Post("v1/inbox/:id/snooze")
  snooze(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("until") until: string) {
    return this.inbox.snooze(id, user.userId, new Date(until));
  }
}
