import { Body, Controller, Delete, Get, Inject, Param, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AttentionService } from "./attention.service";
import { InboxService } from "./inbox.service";
import {
  CorrectInboxItemDtoSchema,
  type CorrectInboxItemDto,
  BulkInboxActionDtoSchema,
  type BulkInboxActionDto,
  AddToCalendarDtoSchema,
  type AddToCalendarDto,
  ApplyRescheduleDtoSchema,
  type ApplyRescheduleDto,
  AddTrustedRescheduleRuleDtoSchema,
  type AddTrustedRescheduleRuleDto,
  ResolveDateDisagreementDtoSchema,
  type ResolveDateDisagreementDto,
  AddSenderRuleDtoSchema,
  type AddSenderRuleDto,
  AddSenderRuleFromInboxItemDtoSchema,
  type AddSenderRuleFromInboxItemDto,
} from "./dto";

@Controller()
@UseGuards(AuthGuard)
export class AttentionController {
  constructor(
    @Inject(AttentionService) private readonly attention: AttentionService,
    @Inject(InboxService) private readonly inbox: InboxService,
  ) {}

  @Get("v1/home")
  home(@CurrentUser() user: AuthenticatedUser) {
    return this.attention.home(user.userId);
  }

  /** HOME-002 — personal today-window view, works for every account regardless of household membership. */
  @Get("v1/today")
  today(@CurrentUser() user: AuthenticatedUser) {
    return this.attention.personalToday(user.userId);
  }

  @Post("v1/attention/:id/resolve")
  resolve(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.attention.resolve(id, user.userId);
  }

  @Post("v1/attention/:id/dismiss")
  dismiss(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("reason") reason?: string) {
    return this.attention.dismiss(id, user.userId, reason ?? "not_relevant");
  }

  @Get("v1/inbox")
  list(@CurrentUser() user: AuthenticatedUser, @Query("reviewState") reviewState?: string, @Query("category") category?: string) {
    return this.inbox.list(user.userId, { reviewState, category });
  }

  // CAL-004 trusted-reschedule-rule settings surface — registered before the `:id/...` routes below for
  // the same reason the bulk routes are (a literal "reschedule-trust-rules" segment must never be treated
  // as a candidate value for the `:id` param).
  @Get("v1/inbox/reschedule-trust-rules")
  listTrustedRescheduleRules(@CurrentUser() user: AuthenticatedUser) {
    return this.inbox.listTrustedRescheduleRules(user.userId);
  }

  @Post("v1/inbox/reschedule-trust-rules")
  @UsePipes(new ZodValidationPipe(AddTrustedRescheduleRuleDtoSchema))
  addTrustedRescheduleRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddTrustedRescheduleRuleDto) {
    return this.inbox.addTrustedRescheduleRule(user.userId, dto.senderDomain);
  }

  @Delete("v1/inbox/reschedule-trust-rules/:id")
  async removeTrustedRescheduleRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.inbox.removeTrustedRescheduleRule(id, user.userId);
    return { success: true };
  }

  // MAIL-006 "User sender rules" settings surface — same "register before the `:id/...` routes" ordering
  // reasoning as reschedule-trust-rules above.
  @Get("v1/inbox/sender-rules")
  listSenderRules(@CurrentUser() user: AuthenticatedUser) {
    return this.inbox.listSenderRules(user.userId);
  }

  @Post("v1/inbox/sender-rules")
  @UsePipes(new ZodValidationPipe(AddSenderRuleDtoSchema))
  addSenderRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: AddSenderRuleDto) {
    return this.inbox.addSenderRule(user.userId, dto);
  }

  @Delete("v1/inbox/sender-rules/:id")
  async removeSenderRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.inbox.removeSenderRule(id, user.userId);
    return { success: true };
  }

  // Registered before the `:id/confirm`/`:id/dismiss` routes below — Fastify's router would otherwise
  // treat the literal "bulk" segment as a candidate value for the `:id` param and never reach these.
  @Post("v1/inbox/bulk/confirm")
  @UsePipes(new ZodValidationPipe(BulkInboxActionDtoSchema))
  bulkConfirm(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkInboxActionDto) {
    return this.inbox.bulkAction("confirm", dto.ids, user.userId);
  }

  @Post("v1/inbox/bulk/dismiss")
  @UsePipes(new ZodValidationPipe(BulkInboxActionDtoSchema))
  bulkDismiss(@CurrentUser() user: AuthenticatedUser, @Body() dto: BulkInboxActionDto) {
    return this.inbox.bulkAction("dismiss", dto.ids, user.userId);
  }

  @Post("v1/inbox/:id/confirm")
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.confirm(id, user.userId);
  }

  @Post("v1/inbox/:id/add-to-calendar")
  @UsePipes(new ZodValidationPipe(AddToCalendarDtoSchema))
  addToCalendar(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AddToCalendarDto) {
    return this.inbox.addToCalendar(id, user.userId, dto);
  }

  @Post("v1/inbox/:id/apply-reschedule")
  @UsePipes(new ZodValidationPipe(ApplyRescheduleDtoSchema))
  applyReschedule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: ApplyRescheduleDto) {
    return this.inbox.applyRescheduleChange(id, user.userId, dto);
  }

  @Post("v1/inbox/:id/resolve-date-disagreement")
  @UsePipes(new ZodValidationPipe(ResolveDateDisagreementDtoSchema))
  async resolveDateDisagreement(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: ResolveDateDisagreementDto) {
    await this.inbox.resolveDateDisagreement(id, user.userId, dto.choice);
    return { success: true };
  }

  @Post("v1/inbox/:id/correct")
  @UsePipes(new ZodValidationPipe(CorrectInboxItemDtoSchema))
  correct(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CorrectInboxItemDto) {
    return this.inbox.correct(id, user.userId, dto);
  }

  // MAIL-006 "From Inbox: Always treat messages from this sender as..." — the inline correction-flow
  // action; see InboxService.addSenderRuleFromInboxItem's own doc comment for why this scopes to the
  // sender's domain rather than its exact address.
  @Post("v1/inbox/:id/sender-rule")
  @UsePipes(new ZodValidationPipe(AddSenderRuleFromInboxItemDtoSchema))
  addSenderRuleFromInboxItem(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: AddSenderRuleFromInboxItemDto) {
    return this.inbox.addSenderRuleFromInboxItem(id, user.userId, dto.action);
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
