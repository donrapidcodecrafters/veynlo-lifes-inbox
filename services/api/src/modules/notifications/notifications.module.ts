import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService } from "./notifications.service";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { MailerService } from "./mailer.service";

@Module({
  imports: [IdentityModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationDeliveryService, NotificationDispatchService, MailerService],
  exports: [NotificationsService, NotificationDeliveryService, NotificationDispatchService, MailerService],
})
export class NotificationsModule {}
