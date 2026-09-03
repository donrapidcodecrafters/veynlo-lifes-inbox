import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { PreferencesModule } from "../preferences/preferences.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { MailerService } from "./mailer.service";
import { PushService } from "./push.service";
import { EMAIL_PROVIDER, PUSH_PROVIDER } from "./notification-provider.interface";

// PreferencesModule — FIN-007 "hidden on ... notifications": NotificationDispatchService reads
// PreferencesService.isFinancialPrivacyModeEnabled to mask dollar amounts in brief copy. PreferencesModule
// only imports IdentityModule itself (never NotificationsModule), so this doesn't create a cycle — same
// reasoning IdentityModule's own doc comment gives for why NotificationsModule -> IdentityModule is safe.
@Module({
  imports: [IdentityModule, PreferencesModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    NotificationDispatchService,
    MailerService,
    PushService,
    { provide: EMAIL_PROVIDER, useExisting: MailerService },
    { provide: PUSH_PROVIDER, useExisting: PushService },
  ],
  exports: [NotificationsService, NotificationDeliveryService, NotificationDispatchService, MailerService, PushService],
})
export class NotificationsModule {}
