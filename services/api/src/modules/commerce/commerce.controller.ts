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

  @Post("purchases/:id/link-person")
  linkPersonToPurchase(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.commerce.setPersonLink("purchase", id, user.userId, personId, true);
  }

  @Post("purchases/:id/unlink-person")
  unlinkPersonFromPurchase(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.commerce.setPersonLink("purchase", id, user.userId, personId, false);
  }

  @Get("returns")
  returns(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.returns(user.userId);
  }

  @Get("returns/:id")
  returnDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.returnDetail(id, user.userId);
  }

  @Post("returns/:id/state")
  setReturnCaseState(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("state") state: string) {
    return this.commerce.setReturnCaseState(id, user.userId, state);
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

  @Post("bills/:id/link-person")
  linkPersonToBill(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.commerce.setPersonLink("bill", id, user.userId, personId, true);
  }

  @Post("bills/:id/unlink-person")
  unlinkPersonFromBill(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.commerce.setPersonLink("bill", id, user.userId, personId, false);
  }

  @Get("warranties")
  warranties(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.warranties(user.userId);
  }

  @Get("warranties/:id")
  warrantyDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.warrantyDetail(id, user.userId);
  }

  @Post("warranties/:id/link-person")
  linkPersonToWarranty(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.commerce.setPersonLink("warranty", id, user.userId, personId, true);
  }

  @Post("warranties/:id/unlink-person")
  unlinkPersonFromWarranty(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body("personId") personId: string) {
    return this.commerce.setPersonLink("warranty", id, user.userId, personId, false);
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
