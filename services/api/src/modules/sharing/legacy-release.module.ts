import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { AdminModule } from "../admin/admin.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { SharingModule } from "./sharing.module";
import { LegacyReleaseController } from "./legacy-release.controller";
import { LegacyReleaseAdminController } from "./legacy-release-admin.controller";
import { LegacyReleasePublicController } from "./legacy-release-public.controller";
import { LegacyReleaseService } from "./legacy-release.service";

/** §35 SHARE-006 — see LegacyReleaseService's own doc comment. IdentityModule only for
 * IdentityService.verifyStepUpPassword (same import EmergencyBinderModule already makes for the identical
 * reason); AdminModule for AdminGuard/SuperAdminGuard/AdminAuthService, which legacy-release-admin.
 * controller.ts's `@UseGuards` needs resolvable in THIS module's DI graph (AdminModule now exports them —
 * see its own doc comment). NotificationsModule for NotificationDeliveryService, the "are you still
 * there?" inactivity-warning email's delivery chokepoint (see LegacyReleaseService.sendInactivityWarning) —
 * imports only IdentityModule/PreferencesModule itself, so this doesn't create a cycle. */
@Module({
  imports: [IdentityModule, AdminModule, NotificationsModule, SharingModule],
  controllers: [LegacyReleaseController, LegacyReleaseAdminController, LegacyReleasePublicController],
  providers: [LegacyReleaseService],
  exports: [LegacyReleaseService],
})
export class LegacyReleaseModule {}
