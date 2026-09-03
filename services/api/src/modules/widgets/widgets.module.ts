import { Module } from "@nestjs/common";
import { PreferencesModule } from "../preferences/preferences.module";
import { WidgetsController, WidgetDeepLinkController } from "./widgets.controller";
import { WidgetsService } from "./widgets.service";

// PreferencesModule — FIN-007 "hidden on ... widgets": WidgetsService reads
// PreferencesService.isFinancialPrivacyModeEnabled to mask any dollar amount in a widget projection.
@Module({
  imports: [PreferencesModule],
  controllers: [WidgetsController, WidgetDeepLinkController],
  providers: [WidgetsService],
  exports: [WidgetsService],
})
export class WidgetsModule {}
