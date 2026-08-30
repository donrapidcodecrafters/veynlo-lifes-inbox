import { Module } from "@nestjs/common";
import { DataIntegrityService } from "./data-integrity.service";

@Module({
  providers: [DataIntegrityService],
  exports: [DataIntegrityService],
})
export class DataIntegrityModule {}
