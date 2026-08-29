import { Body, Controller, Headers, Logger, Post, ServiceUnavailableException, UnauthorizedException, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { loadEnv, isInboundEmailConfigured } from "../../config/env";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { IdentityService } from "../identity/identity.service";
import { IngestionService } from "./ingestion.service";
import { InboundEmailWebhookDtoSchema, type InboundEmailWebhookDto } from "./dto";

/** Pulls the alias local-part out of a raw email "To" header, which may be a bare address or
 * `"Display Name <address>"` — same ambiguity every inbound-parse provider's "To" field has. */
function extractAliasFromToHeader(to: string): string | null {
  const match = to.match(/<([^>]+)>/);
  const address = (match?.[1] ?? to).trim().toLowerCase();
  const at = address.indexOf("@");
  if (at <= 0) return null;
  return address.slice(0, at);
}

/**
 * CAP-005 "forward-to-Life-Inbox address" (§12.1/§52.1) — the lowest-permission capture path: no OAuth
 * grant, no shared inbox access, just forwarding mail to a per-user alias. Deliberately NOT under
 * IngestionController's class-level AuthGuard — the caller is an inbound-email provider, not a signed-in
 * user, so "who does this belong to" is resolved from the alias in the "To" address instead of a session.
 * Authenticity comes from a shared webhook secret (same static-header pattern as RevenueCat's webhook),
 * not a user session.
 */
@Controller("v1/ingestion")
export class InboundEmailController {
  private readonly logger = new Logger(InboundEmailController.name);

  constructor(
    private readonly ingestion: IngestionService,
    private readonly identity: IdentityService,
  ) {}

  @Post("inbound-email")
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(InboundEmailWebhookDtoSchema))
  async inboundEmail(@Headers("x-inbound-webhook-secret") secret: string | undefined, @Body() body: InboundEmailWebhookDto) {
    if (!isInboundEmailConfigured()) {
      throw new ServiceUnavailableException({
        code: "INBOUND_EMAIL_NOT_CONFIGURED",
        message: "Inbound email isn't configured on this deployment.",
      });
    }
    if (secret !== loadEnv().INBOUND_EMAIL_WEBHOOK_SECRET) {
      throw new UnauthorizedException({ code: "INVALID_WEBHOOK_SECRET", message: "Invalid webhook secret." });
    }

    const alias = extractAliasFromToHeader(body.To);
    const ownerUserId = alias ? await this.identity.findUserIdByInboundAlias(alias) : null;
    if (!ownerUserId) {
      // No matching/rotated-away alias — logged, not an error. A provider would otherwise retry a
      // permanently-unroutable message forever; 200 tells it the delivery attempt is done.
      this.logger.warn(`Inbound email to unrecognized alias "${body.To}" — dropped.`);
      return { received: true, routed: false };
    }

    const { sourceEventId } = await this.ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: body.Subject,
      bodyText: body.TextBody,
      fromAddress: body.From,
      kind: "inbound_email",
    });
    return { received: true, routed: true, sourceEventId };
  }
}
