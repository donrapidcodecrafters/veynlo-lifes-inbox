import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { BillingModule } from "../billing/billing.module";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorsController } from "./connectors.controller";
import { ConnectorsService } from "./connectors.service";
import { GmailAdapter } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import { GoogleTasksAdapter } from "./google-tasks.adapter";
import { MicrosoftTodoAdapter } from "./microsoft-todo.adapter";

@Module({
  imports: [IdentityModule, IngestionModule, BillingModule],
  controllers: [ConnectorsController],
  providers: [
    ConnectorsService,
    GmailAdapter,
    OutlookAdapter,
    IcsAdapter,
    GoogleCalendarAdapter,
    MicrosoftCalendarAdapter,
    GoogleTasksAdapter,
    MicrosoftTodoAdapter,
    CredentialVault,
  ],
  exports: [
    ConnectorsService,
    GmailAdapter,
    OutlookAdapter,
    IcsAdapter,
    GoogleCalendarAdapter,
    MicrosoftCalendarAdapter,
    GoogleTasksAdapter,
    MicrosoftTodoAdapter,
    CredentialVault,
  ],
})
export class ConnectorsModule {}
