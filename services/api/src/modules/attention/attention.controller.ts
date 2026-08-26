import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { AttentionService } from "./attention.service";
import { InboxService } from "./inbox.service";

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

  @Post("v1/inbox/:id/confirm")
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.inbox.confirm(id, user.userId);
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
