import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { detectPlatform } from "../../common/platform";
import { toAnalyticsPlatform } from "../analytics/analytics.service";
import { SearchService } from "./search.service";

@Controller("v1")
@UseGuards(AuthGuard)
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Get("search")
  structured(@CurrentUser() user: AuthenticatedUser, @Query("q") q: string) {
    return this.search.structuredSearch(user.userId, q ?? "");
  }

  // §28.8/§28.16 layered rate limiting — EntitlementsService.assertAskQuota (inside search.service.ts) is
  // the real cost control (a per-plan daily cap), enforced regardless of this; this is the secondary,
  // per-minute layer the blueprint separately calls for so a burst can't be used to probe behavior/timing
  // even from inside a day's quota.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("ask")
  ask(@CurrentUser() user: AuthenticatedUser, @Body("question") question: string, @Req() req: FastifyRequest) {
    return this.search.ask(user.userId, question, toAnalyticsPlatform(detectPlatform(req)));
  }
}
