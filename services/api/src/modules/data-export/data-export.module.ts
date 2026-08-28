import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { DocumentsModule } from "../documents/documents.module";
import { DataExportController } from "./data-export.controller";
import { DataExportService } from "./data-export.service";

@Module({
  imports: [IdentityModule, DocumentsModule],
  controllers: [DataExportController],
  providers: [DataExportService],
  exports: [DataExportService],
})
export class DataExportModule {}
