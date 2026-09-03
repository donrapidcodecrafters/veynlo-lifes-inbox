import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MailerService } from "../notifications/mailer.service";
import { HouseholdController } from "./household.controller";
import { HouseholdService } from "./household.service";

// MailerService is provided here directly rather than importing NotificationsModule, same reasoning as
// identity.module.ts: it has no dependencies of its own, so a second lightweight instance is harmless and
// avoids adding a module-import edge purely for one lightweight service.
@Module({
  imports: [IdentityModule, EntitlementsModule],
  controllers: [HouseholdController],
  providers: [HouseholdService, MailerService],
  exports: [HouseholdService],
})
export class HouseholdModule {}
