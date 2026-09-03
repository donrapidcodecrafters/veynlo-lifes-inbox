import { Body, Controller, Get, Headers, Inject, Post, Req, UseGuards, UsePipes } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { BillingService } from "./billing.service";
import { RevenueCatService } from "./revenuecat.service";
import { CreateCheckoutSessionDtoSchema, type CreateCheckoutSessionDto } from "./dto";

@Controller("v1/billing")
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(RevenueCatService) private readonly revenueCat: RevenueCatService,
  ) {}

  @Get("entitlements")
  @UseGuards(AuthGuard)
  entitlements(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.currentEntitlements(user.userId);
  }

  @Get("plans")
  @UseGuards(AuthGuard)
  plans() {
    return this.billing.plans();
  }

  @Post("checkout-session")
  @UseGuards(AuthGuard)
  @UsePipes(new ZodValidationPipe(CreateCheckoutSessionDtoSchema))
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateCheckoutSessionDto) {
    return this.billing.createCheckoutSession(user.userId, body.planKey, body.priceId);
  }

  @Post("portal-session")
  @UseGuards(AuthGuard)
  portalSession(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.createPortalSession(user.userId);
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
