import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { FinanceService } from "./finance.service";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { SetAccountIncludedDtoSchema, type SetAccountIncludedDto } from "./dto";

@Controller("v1/finance")
@UseGuards(AuthGuard)
export class FinanceController {
  constructor(@Inject(FinanceService) private readonly finance: FinanceService) {}

  @Get("accounts")
  accounts(@CurrentUser() user: AuthenticatedUser) {
    return this.finance.accounts(user.userId);
  }

  /** FIN-001 "account list allows per-account inclusion/exclusion" toggle. */
  @Patch("accounts/:id")
  @UsePipes(new ZodValidationPipe(SetAccountIncludedDtoSchema))
  setAccountIncluded(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetAccountIncludedDto) {
    return this.finance.setAccountIncluded(id, user.userId, dto.isIncluded);
  }

  @Get("accounts/:id")
  accountDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.finance.accountDetail(id, user.userId);
  }

  /** FIN-001 — total balance across only the accounts a user hasn't excluded. */
  @Get("summary")
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.finance.summary(user.userId);
  }

  @Get("transactions")
  transactions(@CurrentUser() user: AuthenticatedUser, @Query("accountId") accountId?: string) {
    return this.finance.transactions(user.userId, accountId);
  }

  /** FIN-002 "preserve provider transaction ID history and transaction revisions" — every captured
   * before-state snapshot for one transaction, newest first. */
  @Get("transactions/:id/revisions")
  transactionRevisions(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.finance.transactionRevisions(id, user.userId);
  }

  /** FIN-003 — read-only detected paycheck/income streams, recomputed on every request. */
  @Get("income-streams")
  incomeStreams(@CurrentUser() user: AuthenticatedUser) {
    return this.finance.detectIncomeStreams(user.userId);
  }

  @Post("income-streams/:id/dismiss")
  dismissIncomeStream(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.finance.dismissIncomeStream(id, user.userId);
  }
}
