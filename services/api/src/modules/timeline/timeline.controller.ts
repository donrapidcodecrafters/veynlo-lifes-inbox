import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { TimelineService } from "./timeline.service";

@Controller("v1/timeline")
@UseGuards(AuthGuard)
export class TimelineController {
  constructor(private readonly timeline: TimelineService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser, @Query("before") before?: string) {
    return this.timeline.getTimeline(user.userId, before ?? null);
  }
}
