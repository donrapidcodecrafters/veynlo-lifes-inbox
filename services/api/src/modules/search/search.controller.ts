import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
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
  ask(
    @CurrentUser() user: AuthenticatedUser,
    @Body("question") question: string,
    @Body("history") history?: Array<{ question: string; answer: string }>,
  ) {
    return this.search.ask(user.userId, question, history ?? []);
  }

  @Post("saved-queries")
  saveQuery(@CurrentUser() user: AuthenticatedUser, @Body("questionText") questionText: string) {
    return this.search.saveQuery(user.userId, questionText);
  }

  @Get("saved-queries")
  listSavedQueries(@CurrentUser() user: AuthenticatedUser) {
    return this.search.listSavedQueries(user.userId);
  }

  @Post("saved-queries/:id/delete")
  deleteSavedQuery(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.search.deleteSavedQuery(id, user.userId);
  }
}
