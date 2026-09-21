import { Module } from "@nestjs/common";
import { HouseholdModule } from "../household/household.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { SchoolController } from "./school.controller";
import { SchoolService } from "./school.service";
import { SchoolIcsService } from "./school-ics.service";
import { CanvasService } from "./canvas.service";

@Module({
  imports: [HouseholdModule, ScheduleModule, IngestionModule],
  controllers: [SchoolController],
  providers: [SchoolService, SchoolIcsService, CanvasService],
  exports: [SchoolService, SchoolIcsService, CanvasService],
})
export class SchoolModule {}
