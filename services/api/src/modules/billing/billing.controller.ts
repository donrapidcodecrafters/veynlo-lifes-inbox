import { Body, Controller, Get, Headers, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PlanKey } from "@veynlo/core";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { BillingService } from "./billing.service";
import { RevenueCatService } from "./revenuecat.service";

@Controller("v1/billing")
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly revenueCat: RevenueCatService,
  ) {}

  @Get("entitlements")
  @UseGuards(AuthGuard)
  entitlements(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.currentEntitlements(user.userId);
  }

  @Post("checkout-session")
  @UseGuards(AuthGuard)
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: { planKey: PlanKey; priceId: string }) {
    return this.billing.createCheckoutSession(user.userId, body.planKey, body.priceId);
  }

  // No AuthGuard — Stripe calls this directly; authenticity comes from signature verification, not a session.
  @Post("webhook")
  async webhook(@Req() req: FastifyRequest, @Headers("stripe-signature") signature: string) {
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody) throw new Error("Raw body capture is not configured for this route.");
    await this.billing.handleWebhook(rawBody, signature);
    return { received: true };
  }

  // No AuthGuard — RevenueCat calls this directly; authenticity comes from the shared auth header, not a session.
  @Post("revenuecat-webhook")
  async revenueCatWebhook(@Body() body: unknown, @Headers("authorization") authHeader: string | undefined) {
    await this.revenueCat.handleWebhook(authHeader, body);
    return { received: true };
  }
}
