import { Controller, Delete, Get, Inject, Param, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { SharingHubService } from "./sharing-hub.service";

/** §35 SHARE-007 "Central 'Shared by me' and 'Shared with me' screens" — see SharingHubService's own doc
 * comment. */
@Controller("v1/sharing")
@UseGuards(AuthGuard)
export class SharingHubController {
  constructor(@Inject(SharingHubService) private readonly hub: SharingHubService) {}

  @Get("shared-by-me")
  sharedByMe(@CurrentUser() user: AuthenticatedUser) {
    return this.hub.sharedByMe(user.userId);
  }

  @Get("shared-with-me")
  sharedWithMe(@CurrentUser() user: AuthenticatedUser) {
    return this.hub.sharedWithMe(user.userId);
  }

  @Delete("grants/:grantId")
  async revokeGrant(@CurrentUser() user: AuthenticatedUser, @Param("grantId") grantId: string) {
    await this.hub.revokeGrant(grantId, user.userId);
    return { success: true };
  }

  @Delete("share-links/:linkId")
  async revokeShareLink(@CurrentUser() user: AuthenticatedUser, @Param("linkId") linkId: string) {
    await this.hub.revokeShareLink(linkId, user.userId);
    return { success: true };
  }
}
