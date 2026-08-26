import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { DocumentsController } from "./documents.controller";
import { DocumentsService } from "./documents.service";
import { StorageService } from "./storage.service";

@Module({
  imports: [IdentityModule, IntelligenceModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, StorageService],
  exports: [DocumentsService, StorageService],
})
export class DocumentsModule {}
