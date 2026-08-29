import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { MailModule } from "../mail/mail.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { PushService } from "./push.service";

@Module({
  imports: [IdentityModule, MailModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDeliveryService, NotificationDispatchService, PushService],
  exports: [NotificationsService, NotificationDeliveryService, NotificationDispatchService, PushService, MailModule],
})
export class NotificationsModule {}
