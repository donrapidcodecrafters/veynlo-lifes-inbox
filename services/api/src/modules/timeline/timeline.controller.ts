import { BadRequestException, Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { TimelineService, type TimelineKind } from "./timeline.service";

const VALID_KINDS = new Set<TimelineKind>(["calendar_event", "purchase", "bill", "document", "return_case", "warranty", "shipment"]);

@Controller("v1/timeline")
@UseGuards(AuthGuard)
export class TimelineController {
  constructor(private readonly timeline: TimelineService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser, @Query("before") before?: string, @Query("kind") kind?: string, @Query("search") search?: string) {
    const validatedKind = kind && VALID_KINDS.has(kind as TimelineKind) ? (kind as TimelineKind) : null;
    return this.timeline.getTimeline(user.userId, before ?? null, validatedKind, search ?? null);
  }

  @Get("export")
  async export(@CurrentUser() user: AuthenticatedUser, @Query("from") from: string, @Query("to") to: string, @Res() res: FastifyReply) {
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      throw new BadRequestException({ code: "INVALID_RANGE", message: "from and to must both be valid dates." });
    }
    const csv = await this.timeline.exportRange(user.userId, from, to);
    res
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="veynlo-timeline-${from.slice(0, 10)}-to-${to.slice(0, 10)}.csv"`)
      .send(csv);
  }
}
