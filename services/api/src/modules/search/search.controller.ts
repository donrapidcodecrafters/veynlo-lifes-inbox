import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { SearchService } from "./search.service";

@Controller("v1")
@UseGuards(AuthGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get("search")
  structured(@CurrentUser() user: AuthenticatedUser, @Query("q") q: string) {
    return this.search.structuredSearch(user.userId, q ?? "");
  }

  @Post("ask")
  ask(@CurrentUser() user: AuthenticatedUser, @Body("question") question: string) {
    return this.search.ask(user.userId, question);
  }
}
