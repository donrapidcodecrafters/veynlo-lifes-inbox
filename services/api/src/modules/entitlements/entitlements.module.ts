import { Module } from "@nestjs/common";
import { EntitlementsService } from "./entitlements.service";

@Module({
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
