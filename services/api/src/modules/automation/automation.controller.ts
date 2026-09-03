import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { z } from "zod";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { AutomationService } from "./automation.service";
import { CreateRuleFromTextDtoSchema, type CreateRuleFromTextDto, UpdateRuleDtoSchema, type UpdateRuleDto } from "./dto";

const SetKillSwitchDtoSchema = z.object({ paused: z.boolean() });
type SetKillSwitchDto = z.infer<typeof SetKillSwitchDtoSchema>;

@Controller("v1/automation")
@UseGuards(AuthGuard)
export class AutomationController {
  constructor(@Inject(AutomationService) private readonly automation: AutomationService) {}

  @Post("rules")
  @UsePipes(new ZodValidationPipe(CreateRuleFromTextDtoSchema))
  createRule(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateRuleFromTextDto) {
    return this.automation.createRuleFromText(user.userId, dto);
  }

  @Get("rules")
  listRules(@CurrentUser() user: AuthenticatedUser) {
    return this.automation.listRules(user.userId);
  }

  @Put("rules/:id")
  @UsePipes(new ZodValidationPipe(UpdateRuleDtoSchema))
  async updateRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdateRuleDto) {
    await this.automation.updateRule(id, user.userId, dto);
    return { success: true };
  }

  @Delete("rules/:id")
  async deleteRule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.automation.deleteRule(id, user.userId);
    return { success: true };
  }

  @Get("runs")
  listRuns(@CurrentUser() user: AuthenticatedUser) {
    return this.automation.listRuns(user.userId);
  }

  @Post("runs/:id/approve")
  async approveRun(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.automation.approveRun(id, user.userId);
    return { success: true };
  }

  @Post("runs/:id/reject")
  async rejectRun(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.automation.rejectRun(id, user.userId);
    return { success: true };
  }

  @Post("runs/:id/undo")
  async undoRun(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.automation.undoRun(id, user.userId);
    return { success: true };
  }

  @Get("kill-switch")
  getKillSwitch(@CurrentUser() user: AuthenticatedUser) {
    return this.automation.getKillSwitchStatus(user.userId);
  }

  @Put("kill-switch")
  @UsePipes(new ZodValidationPipe(SetKillSwitchDtoSchema))
  async setKillSwitch(@CurrentUser() user: AuthenticatedUser, @Body() dto: SetKillSwitchDto) {
    await this.automation.setKillSwitch(user.userId, dto.paused);
    return { success: true };
  }

  // §34.1 L2 "prepare_cancellation" — AUTO-003 "Prepared actions": staged, real merchant steps a user
  // reviews and confirms/dismisses themselves. See AutomationService.listPreparedActions's own doc comment.
  @Get("prepared-actions")
  listPreparedActions(@CurrentUser() user: AuthenticatedUser) {
    return this.automation.listPreparedActions(user.userId);
  }

  @Post("prepared-actions/:id/confirm")
  async confirmPreparedAction(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.automation.confirmPreparedAction(id, user.userId);
    return { success: true };
  }

  @Post("prepared-actions/:id/dismiss")
  async dismissPreparedAction(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.automation.dismissPreparedAction(id, user.userId);
    return { success: true };
  }
}
