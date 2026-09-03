import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IngestionModule } from "../ingestion/ingestion.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { DocumentsModule } from "../documents/documents.module";
import { ScheduleModule } from "../schedule/schedule.module";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorsController } from "./connectors.controller";
import { CalendarActionsController } from "./calendar-actions.controller";
import { WebhooksController } from "./webhooks.controller";
import { ConnectorsService } from "./connectors.service";
import { CalendarWriteBackService } from "./calendar-write-back.service";
import { GmailAdapter } from "./gmail.adapter";
import { OutlookAdapter } from "./outlook.adapter";
import { IcsAdapter } from "./ics.adapter";
import { GoogleCalendarAdapter } from "./google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./microsoft-calendar.adapter";
import { GoogleContactsAdapter } from "./google-contacts.adapter";
import { MicrosoftContactsAdapter } from "./microsoft-contacts.adapter";
import { GoogleDriveAdapter } from "./google-drive.adapter";
import { OneDriveAdapter } from "./onedrive.adapter";
import { DropboxAdapter } from "./dropbox.adapter";
import { GoogleTasksAdapter } from "./google-tasks.adapter";
import { MicrosoftToDoAdapter } from "./microsoft-todo.adapter";
import { PlaidAdapter } from "./plaid.adapter";

const ADAPTERS = [
  GmailAdapter,
  OutlookAdapter,
  IcsAdapter,
  GoogleCalendarAdapter,
  MicrosoftCalendarAdapter,
  GoogleContactsAdapter,
  MicrosoftContactsAdapter,
  GoogleDriveAdapter,
  OneDriveAdapter,
  DropboxAdapter,
  GoogleTasksAdapter,
  MicrosoftToDoAdapter,
  PlaidAdapter,
];

@Module({
  imports: [IdentityModule, IngestionModule, EntitlementsModule, DocumentsModule, ScheduleModule],
  controllers: [ConnectorsController, CalendarActionsController, WebhooksController],
  providers: [ConnectorsService, CalendarWriteBackService, ...ADAPTERS, CredentialVault],
  // CalendarWriteBackService is exported so AttentionModule (InboxService's "add to calendar" destination
  // choice — CAL-002) can use the same push logic this module's own CalendarActionsController uses,
  // without AttentionModule needing anything else this module provides.
  exports: [ConnectorsService, CalendarWriteBackService, ...ADAPTERS, CredentialVault],
})
export class ConnectorsModule {}
