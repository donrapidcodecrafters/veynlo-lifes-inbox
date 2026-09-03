import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { SharingModule } from "../sharing/sharing.module";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";
import { AssetsController } from "./assets.controller";
import { AssetsService } from "./assets.service";
import { RecallMonitorService } from "./recall-monitor.service";
import { VinDecodeService } from "./vin-decode.service";

@Module({
  // SafeUrlFetcher is provided directly here (not via IngestionModule) deliberately: SafeUrlFetcher has no
  // dependencies of its own (see its own file — a bare `@Injectable()` with no constructor), and
  // IngestionModule imports ScheduleModule, which (once ScheduleModule is wired to AssetsService for
  // VEH-007 mileage-recurrence lookups) would import AssetsModule right back — a real cycle. Providing the
  // standalone class directly here sidesteps that without needing a whole extra module boundary.
  imports: [HouseholdModule, SharingModule],
  controllers: [AssetsController],
  // VinDecodeService (VEH-001) — same standalone-SafeUrlFetcher-dependent shape as RecallMonitorService,
  // just a different free/no-key NHTSA endpoint.
  providers: [AssetsService, RecallMonitorService, VinDecodeService, SafeUrlFetcher],
  exports: [AssetsService, RecallMonitorService, VinDecodeService],
})
export class AssetsModule {}
