import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";

@Module({
  imports: [IdentityModule, IngestionModule],
  controllers: [ConnectorsController],
  providers: [ConnectorsService, GmailAdapter, OutlookAdapter, IcsAdapter, GoogleCalendarAdapter, CredentialVault],
  exports: [ConnectorsService, GmailAdapter, OutlookAdapter, IcsAdapter, GoogleCalendarAdapter, CredentialVault],
})
export class ConnectorsModule {}
