import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { RevenueCatService } from "./revenuecat.service";

@Module({
  imports: [IdentityModule, NotificationsModule],
  controllers: [BillingController],
  providers: [BillingService, RevenueCatService],
  exports: [BillingService, RevenueCatService],
})
export class BillingModule {}
