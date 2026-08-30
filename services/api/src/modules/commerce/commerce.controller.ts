import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
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

  @Post("purchases/:id/state")
  setPurchaseState(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("state") state: string) {
    return this.commerce.setPurchaseState(id, user.userId, state);
  }

  @Get("returns")
  returns(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.returns(user.userId);
  }

  @Get("returns/:id")
  returnDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.returnDetail(id, user.userId);
  }

  @Get("subscriptions")
  subscriptions(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.subscriptions(user.userId);
  }

  @Get("subscriptions/:id")
  subscriptionDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.subscriptionDetail(id, user.userId);
  }

  @Get("bills")
  bills(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.bills(user.userId);
  }

  @Get("bills/:id")
  billDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.billDetail(id, user.userId);
  }

  @Get("warranties")
  warranties(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.warranties(user.userId);
  }

  @Get("warranties/:id")
  warrantyDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.warrantyDetail(id, user.userId);
  }

  @Get("shipments")
  shipments(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.shipments(user.userId);
  }

  @Get("shipments/:id")
  shipmentDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.shipmentDetail(id, user.userId);
  }
}
