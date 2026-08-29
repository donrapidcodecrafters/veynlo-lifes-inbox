import { Module } from "@nestjs/common";
import { MailerService } from "../notifications/mailer.service";

/**
 * Split out of NotificationsModule so IdentityModule can send real email (password-reset) without a
 * circular import — NotificationsModule already imports IdentityModule for user lookups, so the reverse
 * import would have been circular. MailerService's actual file stays in notifications/ since sending
 * notification emails is still its primary use; this module just re-provides it standalone.
 */
@Module({
  providers: [MailerService],
  exports: [MailerService],
})
export class MailModule {}
