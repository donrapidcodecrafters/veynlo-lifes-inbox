import { Body, Controller, Headers, Logger, Post, ServiceUnavailableException, UnauthorizedException, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { loadEnv, isInboundEmailConfigured } from "../../config/env";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { extractEmailAddress } from "../intelligence/deterministic-prefilter";
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
 * §12.1 "Authenticate inbound source with SPF/DKIM/DMARC signals" — a lightweight reading of the
 * `Authentication-Results` header's standard `dmarc=<verdict>` token (RFC 8601), not a full parser for
 * every field the header can carry. DMARC specifically (not SPF/DKIM individually) is the signal checked
 * for outright rejection: DMARC is the policy layer that requires SPF-or-DKIM to align with the visible
 * From domain, so a `dmarc=fail` means the sender is impersonating a domain it isn't authorized to send
 * as — a real spoofing signal for a feature whose entire job is accepting mail from the open internet.
 * SPF or DKIM failing alone is common for legitimately-forwarded mail (many forwarders break SPF) and
 * isn't treated as disqualifying by itself.
 */
function dmarcVerdict(headers: Array<{ Name: string; Value: string }> | undefined): "pass" | "fail" | "none" | null {
  const header = headers?.find((h) => h.Name.toLowerCase() === "authentication-results");
  if (!header) return null;
  const match = header.Value.match(/dmarc=(\w+)/i);
  if (!match) return null;
  const verdict = match[1]?.toLowerCase();
  if (!verdict) return null;
  return verdict === "pass" || verdict === "fail" ? verdict : "none";
}

/** CAP-005 "permitted-senders allowlist mode" — an empty list (the default) never makes this stricter
 * than the existing DMARC check; a non-empty list is opt-in per-user. Each entry is either a full address
 * (exact match) or a domain written "@example.com" (matches any address at that domain). */
export function isSenderPermitted(fromAddress: string, permittedSenders: string[]): boolean {
  if (permittedSenders.length === 0) return true;
  const from = extractEmailAddress(fromAddress);
  const fromDomain = from.slice(from.indexOf("@"));
  return permittedSenders.some((entry) => (entry.startsWith("@") ? fromDomain === entry : from === entry));
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

    if (dmarcVerdict(body.Headers) === "fail") {
      this.logger.warn(`Inbound email to alias "${alias}" failed DMARC — dropped as likely spoofed.`);
      return { received: true, routed: false, reason: "auth_failed" };
    }

    const permittedSenders = await this.identity.getPermittedInboundSenders(ownerUserId);
    if (!isSenderPermitted(body.From, permittedSenders)) {
      this.logger.warn(`Inbound email to alias "${alias}" from a sender not on the permitted-senders allowlist — dropped.`);
      return { received: true, routed: false, reason: "sender_not_permitted" };
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
