import { Module } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { MailerService } from "../notifications/mailer.service";
import { OnboardingModule } from "../onboarding/onboarding.module";
import { AnalyticsModule } from "../analytics/analytics.module";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";
import { PasskeyController } from "./passkey.controller";
import { PasskeyService } from "./passkey.service";

// MailerService is provided here directly (not imported via NotificationsModule) because
// NotificationsModule already imports IdentityModule — importing it back would be a circular module
// dependency. MailerService itself has no dependencies of its own (it reads SMTP config from `loadEnv()`
// lazily), so providing it a second time here is harmless: a second lightweight instance, not a conflict.
// OnboardingModule, unlike NotificationsModule, imports nothing that imports IdentityModule back (it only
// needs EntitlementsModule), so it's imported normally here — ONB-001's onboarding_state row is created at
// the moment an account is created (IdentityService.signUp / findOrCreateOAuthUser), not lazily on read.
@Module({
  imports: [OnboardingModule, AnalyticsModule],
  controllers: [IdentityController, PasskeyController],
  providers: [IdentityService, PasskeyService, AuthGuard, MailerService],
  exports: [IdentityService, AuthGuard],
})
export class IdentityModule {}
