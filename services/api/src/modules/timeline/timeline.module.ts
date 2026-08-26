import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { TimelineController } from "./timeline.controller";
import { TimelineService } from "./timeline.service";

@Module({
  imports: [IdentityModule],
  controllers: [TimelineController],
  providers: [TimelineService],
  exports: [TimelineService],
})
export class TimelineModule {}
