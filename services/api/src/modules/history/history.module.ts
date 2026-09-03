import { Module } from "@nestjs/common";
import { DocumentsModule } from "../documents/documents.module";
import { HistoryController } from "./history.controller";
import { HistoryService } from "./history.service";

@Module({
  imports: [DocumentsModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}
