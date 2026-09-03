import { Module } from "@nestjs/common";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingService } from "./onboarding.service";

// Deliberately does NOT import ConnectorsModule — OnboardingService only needs `isConnectorConfigured`
// (a plain env.ts helper) for the Plaid-configured check, not a live PlaidAdapter instance. Importing
// ConnectorsModule here would create IdentityModule → OnboardingModule → ConnectorsModule → IdentityModule
// (ConnectorsModule already imports IdentityModule for its adapters), a circular module dependency that
// NestJS can only resolve via forwardRef — avoided entirely by not needing the import in the first place.
@Module({
  imports: [EntitlementsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
