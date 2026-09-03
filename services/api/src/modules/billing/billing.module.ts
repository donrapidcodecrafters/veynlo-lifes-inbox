import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { AnalyticsModule } from "../analytics/analytics.module";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { RevenueCatService } from "./revenuecat.service";
import { StripeBillingProvider } from "./stripe-billing-provider.service";
import { BILLING_PROVIDER } from "./billing-provider.interface";

@Module({
  imports: [IdentityModule, AnalyticsModule],
  controllers: [BillingController],
  providers: [BillingService, RevenueCatService, StripeBillingProvider, { provide: BILLING_PROVIDER, useExisting: StripeBillingProvider }],
  exports: [BillingService, RevenueCatService],
})
export class BillingModule {}
