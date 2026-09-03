import { Body, Controller, Inject, Post, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { Param } from "@nestjs/common";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { PublicShareService } from "./public-share.service";
import { AccessShareLinkDtoSchema, type AccessShareLinkDto } from "./dto";

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-002: "expiring link for selected... content without
 * requiring account"). Deliberately its own controller with no class-level `@UseGuards(AuthGuard)` — the
 * whole point of a share link is that the RECIPIENT has no Veynlo session; the token itself (plus an
 * optional passcode) is the trust boundary, same "no ambient session needed" posture as
 * connectors.controller.ts's OAuth callback routes. Generic across every shareable resource type now —
 * see PublicShareService's own doc comment for the dispatch.
 */
@Controller("v1/share")
export class PublicShareController {
  constructor(@Inject(PublicShareService) private readonly publicShare: PublicShareService) {}

  // Unauthenticated and passcode-gated — without a tight rate limit, a high-entropy token is still safe
  // to brute force a low-entropy passcode against, given enough requests. Tighter than every other
  // Throttle in this codebase on purpose (documents.controller.ts's upload allows 20/min).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":token/access")
  @UsePipes(new ZodValidationPipe(AccessShareLinkDtoSchema))
  access(@Param("token") token: string, @Body() dto: AccessShareLinkDto) {
    return this.publicShare.access(token, dto.passcode);
  }
}
