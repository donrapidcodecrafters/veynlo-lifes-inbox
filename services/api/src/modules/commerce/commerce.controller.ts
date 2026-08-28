import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { CommerceService } from "./commerce.service";

@Controller("v1")
@UseGuards(AuthGuard)
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Get("purchases")
  purchases(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.purchases(user.userId);
  }

  @Get("purchases/:id")
  purchaseDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.purchaseDetail(id, user.userId);
  }

  @Get("returns")
  returns(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.returns(user.userId);
  }

  @Get("subscriptions")
  subscriptions(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.subscriptions(user.userId);
  }

  @Get("bills")
  bills(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.bills(user.userId);
  }

  @Get("warranties")
  warranties(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.warranties(user.userId);
  }
}
