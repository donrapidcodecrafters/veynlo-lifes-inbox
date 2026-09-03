import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { CommerceService } from "./commerce.service";
import {
  CreateStoreCreditDtoSchema,
  type CreateStoreCreditDto,
  CreateSubscriptionDtoSchema,
  type CreateSubscriptionDto,
  UpdatePurchaseLineDtoSchema,
  type UpdatePurchaseLineDto,
  SetRecurringStreamEssentialDtoSchema,
  type SetRecurringStreamEssentialDto,
  LinkWarrantyToAssetDtoSchema,
  type LinkWarrantyToAssetDto,
  SetMerchantPriceAdjustmentPolicyDtoSchema,
  type SetMerchantPriceAdjustmentPolicyDto,
  SetMerchantCancellationStepsDtoSchema,
  type SetMerchantCancellationStepsDto,
  MarkReturnLabelReadyDtoSchema,
  type MarkReturnLabelReadyDto,
  CloseReturnDtoSchema,
  type CloseReturnDto,
} from "./dto";
import { CreateResourceGrantDtoSchema, type CreateResourceGrantDto, CreateShareLinkDtoSchema, type CreateShareLinkDto } from "../sharing/dto";

@Controller("v1")
@UseGuards(AuthGuard)
export class CommerceController {
  constructor(@Inject(CommerceService) private readonly commerce: CommerceService) {}

  @Get("purchases")
  purchases(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.purchases(user.userId);
  }

  @Get("purchases/:id")
  purchaseDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.purchaseDetail(id, user.userId);
  }

  @Put("purchases/lines/:id")
  @UsePipes(new ZodValidationPipe(UpdatePurchaseLineDtoSchema))
  async updatePurchaseLine(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: UpdatePurchaseLineDto) {
    await this.commerce.updatePurchaseLine(id, user.userId, dto);
    return { success: true };
  }

  // §40.3 Purchase state machine — `candidate → confirmed`; see CommerceService.confirmPurchase's own doc
  // comment for why this is an explicit user action distinct from the automatic confidence-based path.
  @Post("purchases/:id/confirm")
  async confirmPurchase(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.confirmPurchase(id, user.userId);
    return { success: true };
  }

  // §40.3 Purchase state machine, manual terminal `disposed` — see CommerceService.markPurchaseDisposed's
  // own doc comment for why this has no automatic path.
  @Post("purchases/:id/dispose")
  async markPurchaseDisposed(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.markPurchaseDisposed(id, user.userId);
    return { success: true };
  }

  // RET-004 "Policy engine ... let a user manually add/correct a policy" — the inline editor on the
  // purchase-detail price-adjustment banner reads the current resolved policy via GET, then posts a
  // correction via PUT. Merchant-keyed (not purchase-keyed) since one merchant's policy applies to every
  // purchase from them, not just the one currently being viewed.
  @Get("merchants/:merchantId/price-adjustment-policy")
  merchantPriceAdjustmentPolicy(@CurrentUser() user: AuthenticatedUser, @Param("merchantId") merchantId: string) {
    return this.commerce.merchantPriceAdjustmentPolicy(merchantId, user.userId);
  }

  @Put("merchants/:merchantId/price-adjustment-policy")
  @UsePipes(new ZodValidationPipe(SetMerchantPriceAdjustmentPolicyDtoSchema))
  async setMerchantPriceAdjustmentPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param("merchantId") merchantId: string,
    @Body() dto: SetMerchantPriceAdjustmentPolicyDto,
  ) {
    await this.commerce.setMerchantPriceAdjustmentPolicy(merchantId, user.userId, dto);
    return { success: true };
  }

  // SUB-004 "shows known steps ... let a user manually add/correct" — same shape as the price-adjustment
  // policy routes above: GET reads the resolved (curated or user-corrected) steps for a merchant before an
  // editor lets a user change them, PUT writes this caller's own correction/addition.
  @Get("merchants/:merchantId/cancellation-steps")
  merchantCancellationSteps(@CurrentUser() user: AuthenticatedUser, @Param("merchantId") merchantId: string) {
    return this.commerce.merchantCancellationSteps(merchantId, user.userId);
  }

  @Put("merchants/:merchantId/cancellation-steps")
  @UsePipes(new ZodValidationPipe(SetMerchantCancellationStepsDtoSchema))
  async setMerchantCancellationSteps(
    @CurrentUser() user: AuthenticatedUser,
    @Param("merchantId") merchantId: string,
    @Body() dto: SetMerchantCancellationStepsDto,
  ) {
    await this.commerce.setMerchantCancellationSteps(merchantId, user.userId, dto);
    return { success: true };
  }

  // Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — mirrors documents.controller.ts's
  // grants/share-links routes exactly, generalized via SharingService. Purchases only, among everything
  // else this controller exposes — see CommerceService.assertOwnedPurchase's own doc comment.
  @Post("purchases/:id/grants")
  @UsePipes(new ZodValidationPipe(CreateResourceGrantDtoSchema))
  createPurchaseGrant(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateResourceGrantDto) {
    return this.commerce.createResourceGrant(id, user.userId, dto.granteeEmail, dto.expiresInDays, dto.right, dto.message);
  }

  @Get("purchases/:id/grants")
  listPurchaseGrants(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.listResourceGrants(id, user.userId);
  }

  // SHARE-001 "preview exactly what recipient will see" — same reasoning as ListsController's own.
  @Get("purchases/:id/share-preview")
  purchaseSharePreview(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.sharePreview(id, user.userId);
  }

  @Delete("purchases/grants/:grantId")
  async revokePurchaseGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.commerce.revokeResourceGrant(grantId, user.userId);
    return { success: true };
  }

  @Post("purchases/:id/share-links")
  @UsePipes(new ZodValidationPipe(CreateShareLinkDtoSchema))
  createPurchaseShareLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CreateShareLinkDto) {
    return this.commerce.createShareLink(id, user.userId, dto);
  }

  @Get("purchases/:id/share-links")
  listPurchaseShareLinks(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.listShareLinks(id, user.userId);
  }

  @Delete("purchases/share-links/:linkId")
  async revokePurchaseShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.commerce.revokeShareLink(linkId, user.userId);
    return { success: true };
  }

  /** §35 SHARE-007 "access history" — who's actually viewed this via a grant or a public link. */
  @Get("purchases/:id/access-log")
  listPurchaseAccessEvents(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.listAccessEvents(id, user.userId);
  }

  @Get("returns")
  returns(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.returns(user.userId);
  }

  @Get("returns/:id")
  returnDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.returnDetail(id, user.userId);
  }

  @Post("returns/:id/resolve")
  async resolveReturn(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.resolveReturn(id, user.userId);
    return { success: true };
  }

  // §40.3 Return state machine — eligible → initiated → label/dropoff ready → in transit → merchant
  // received → refund expected → refunded/exchanged/disputed/closed. The granular steps below are new
  // endpoints alongside the pre-existing "resolve" route above, which is left unchanged for backward
  // compatibility (see CommerceService.resolveReturn's own doc comment).
  @Post("returns/:id/initiate")
  async initiateReturn(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.initiateReturn(id, user.userId);
    return { success: true };
  }

  @Post("returns/:id/label-ready")
  @UsePipes(new ZodValidationPipe(MarkReturnLabelReadyDtoSchema))
  async markReturnLabelReady(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: MarkReturnLabelReadyDto) {
    await this.commerce.markReturnLabelReady(id, user.userId, dto);
    return { success: true };
  }

  @Post("returns/:id/refund-expected")
  async markReturnRefundExpected(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.markReturnRefundExpected(id, user.userId);
    return { success: true };
  }

  @Post("returns/:id/close")
  @UsePipes(new ZodValidationPipe(CloseReturnDtoSchema))
  async closeReturn(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: CloseReturnDto) {
    await this.commerce.closeReturn(id, user.userId, dto.outcome);
    return { success: true };
  }

  @Get("shipments")
  shipments(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.shipments(user.userId);
  }

  @Get("shipments/:id")
  shipmentDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.shipmentDetail(id, user.userId);
  }

  @Get("subscriptions")
  subscriptions(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.subscriptions(user.userId);
  }

  @Get("subscriptions/:id")
  subscriptionDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.subscriptionDetail(id, user.userId);
  }

  // SUB-001 "manual add" — the fourth of the spec's four named detection sources (transactions/email/
  // app-store receipts/manual add); see CreateSubscriptionDtoSchema's doc comment for why this was missing.
  @Post("subscriptions")
  @UsePipes(new ZodValidationPipe(CreateSubscriptionDtoSchema))
  createSubscription(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSubscriptionDto) {
    return this.commerce.createSubscription(user.userId, dto);
  }

  @Post("subscriptions/:id/essential")
  @UsePipes(new ZodValidationPipe(SetRecurringStreamEssentialDtoSchema))
  async setSubscriptionEssential(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: SetRecurringStreamEssentialDto) {
    await this.commerce.setSubscriptionEssential(id, user.userId, dto.essential);
    return { success: true };
  }

  // §40.3 Subscription state machine — user-initiated `→ cancellation pending`; see
  // CommerceService.submitSubscriptionCancellation's own doc comment for how the effective date is derived.
  @Post("subscriptions/:id/cancel")
  async submitSubscriptionCancellation(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.submitSubscriptionCancellation(id, user.userId);
    return { success: true };
  }

  // §40.3 Subscription state machine — `active → paused`, gated on merchantSupportsPause; see
  // pause-capability.ts's own doc comment for why no merchant currently qualifies.
  @Post("subscriptions/:id/pause")
  async pauseSubscription(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.pauseSubscription(id, user.userId);
    return { success: true };
  }

  @Post("subscriptions/:id/resume")
  async resumeSubscription(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.resumeSubscription(id, user.userId);
    return { success: true };
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

  @Put("warranties/:id/link-asset")
  @UsePipes(new ZodValidationPipe(LinkWarrantyToAssetDtoSchema))
  async linkWarrantyToAsset(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() dto: LinkWarrantyToAssetDto) {
    await this.commerce.linkWarrantyToAsset(id, user.userId, dto);
    return { success: true };
  }

  @Get("store-credits")
  storeCredits(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.storeCredits(user.userId);
  }

  @Get("store-credits/:id")
  storeCreditDetail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.commerce.storeCreditDetail(id, user.userId);
  }

  @Post("store-credits")
  @UsePipes(new ZodValidationPipe(CreateStoreCreditDtoSchema))
  createStoreCredit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateStoreCreditDto) {
    return this.commerce.createStoreCredit(user.userId, dto);
  }

  @Post("store-credits/:id/redeem")
  async redeemStoreCredit(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.commerce.redeemStoreCredit(id, user.userId);
    return { success: true };
  }

  @Get("monthly-spend-summary")
  monthlySpendSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.monthlySpendSummary(user.userId);
  }

  @Get("savings-summary")
  savingsSummary(@CurrentUser() user: AuthenticatedUser) {
    return this.commerce.savingsSummary(user.userId);
  }
}
