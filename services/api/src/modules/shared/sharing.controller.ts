import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { SharingService } from "./sharing.service";

/** "Shared by me" audit view (§Sharing expansion) — authenticated, unlike SharedController's public
 * token resolver, so this lives in its own controller rather than relaxing that one's no-guard invariant. */
@Controller("v1/shared-links")
@UseGuards(AuthGuard)
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.sharing.listMyShareLinks(user.userId);
  }

  @Post(":id/revoke")
  revoke(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.sharing.revokeShareLinkById(id, user.userId);
  }
}
