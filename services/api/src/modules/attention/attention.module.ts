import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { AttentionController } from "./attention.controller";
import { AttentionService } from "./attention.service";
import { InboxService } from "./inbox.service";

@Module({
  imports: [IdentityModule],
  controllers: [AttentionController],
  providers: [AttentionService, InboxService],
  exports: [AttentionService, InboxService],
})
export class AttentionModule {}
