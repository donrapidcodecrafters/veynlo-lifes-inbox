import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";

@Module({
  imports: [IdentityModule, IngestionModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService, GmailAdapter, OutlookAdapter, IcsAdapter, CredentialVault],
  exports: [ConnectorsService, GmailAdapter, OutlookAdapter, IcsAdapter, CredentialVault],
})
export class ConnectorsModule {}
