import { Controller, Inject, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { LegacyReleaseService } from "./legacy-release.service";

/** §35 SHARE-006 — unauthenticated redemption once a release has actually finalized. Same tight rate
 * limit as PublicShareController/CaregiverDayPassPublicController for the identical reason. */
@Controller("v1/legacy-release-redeem")
export class LegacyReleasePublicController {
  constructor(@Inject(LegacyReleaseService) private readonly legacyRelease: LegacyReleaseService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":token")
  access(@Param("token") token: string) {
    return this.legacyRelease.access(token);
  }
}
