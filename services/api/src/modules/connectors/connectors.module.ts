import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter } from "./gmail.adapter";

@Module({
  imports: [IdentityModule, IngestionModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService, GmailAdapter, CredentialVault],
  exports: [ConnectorsService],
})
export class ConnectorsModule {}
