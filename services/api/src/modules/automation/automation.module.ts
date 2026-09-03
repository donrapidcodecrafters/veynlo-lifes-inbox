import { forwardRef, Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ScheduleModule } from "../schedule/schedule.module";
import type { ConnectorsModule as ConnectorsModuleType } from "../connectors/connectors.module";
import { AutomationController } from "./automation.controller";
import { AutomationService } from "./automation.service";

@Module({
  // ScheduleModule — `add_calendar_event` now routes through ScheduleService.createEvent for real CAL-003
  // conflict detection (see AutomationService.executeRun's own doc comment). One-directional: ScheduleModule
  // never imports AutomationModule (directly or transitively — its own imports are Identity/Household/
  // Notifications/Assets), so this is a plain new edge, not a cycle.
  //
  // ConnectorsModule — AUTO-006/CAL-001 undo needs CalendarWriteBackService.deleteEvent to best-effort clean
  // up a provider-pushed event before deleting its local row (see AutomationService.undoRun). This one IS
  // circular: ConnectorsModule imports IngestionModule, and IngestionModule already imports AutomationModule
  // (to call AutomationService.evaluateEvent from IngestionService.fileInboxItem) — so without forwardRef()
  // this would be AutomationModule -> ConnectorsModule -> IngestionModule -> AutomationModule, a genuine
  // module cycle. This codebase had zero prior forwardRef() usage (grepped before this pass) — NestJS's
  // documented circular-module-dependency resolution is the fix, used here for the first time.
  //
  // The module reference itself is resolved via a lazy `require()`, not a top-level value import of
  // ConnectorsModule (only `import type` above, erased at compile time): a top-level value import here
  // recreates the exact same cycle one file graph level up — confirmed live, booting the app crashed with
  // "Cannot access 'IngestionModule' before initialization" via
  // automation.module.ts -> connectors.module.ts -> ingestion.module.ts -> automation.module.ts, the module
  // file equivalent of the CommonJS TDZ issue AutomationService's own `@Inject(forwardRef(...))` doc comment
  // describes for CalendarWriteBackService. Deferring the `require()` until forwardRef's arrow function
  // actually runs (well after every module file has finished its own initial `require`) avoids it. The
  // corresponding `@Inject(forwardRef(() => require(...)))` for CalendarWriteBackService itself lives on
  // AutomationService's constructor. Verified by actually booting the full Nest module graph
  // (`NestFactory.create(AppModule)`) after wiring this, not just by TypeScript compiling.
  imports: [
    IdentityModule,
    IntelligenceModule,
    NotificationsModule,
    ScheduleModule,
    // Deliberate lazy require: a static import would reintroduce the CommonJS TDZ module cycle
    // described in the comment above.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    forwardRef(() => (require("../connectors/connectors.module") as { ConnectorsModule: unknown }).ConnectorsModule as typeof ConnectorsModuleType),
  ],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
