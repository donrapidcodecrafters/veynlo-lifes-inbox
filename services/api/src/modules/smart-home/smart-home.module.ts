import { Module } from "@nestjs/common";
import { AttentionModule } from "../attention/attention.module";
import { SmartHomeController } from "./smart-home.controller";
import { SmartHomeService } from "./smart-home.service";
import { HomeAssistantService } from "./home-assistant.service";

/**
 * §31 "Smart Home & Connected Devices". One real provider — see `home-assistant.service.ts` for why it is
 * the only one of the nine that can be built here, and why that is a property of the vendors rather than
 * of the effort spent.
 */
@Module({
  imports: [AttentionModule],
  controllers: [SmartHomeController],
  providers: [SmartHomeService, HomeAssistantService],
  exports: [SmartHomeService, HomeAssistantService],
})
export class SmartHomeModule {}
