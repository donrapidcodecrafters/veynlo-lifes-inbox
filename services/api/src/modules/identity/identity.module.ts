import { Module } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { MailModule } from "../mail/mail.module";
import { IdentityController } from "./identity.controller";
import { IdentityService } from "./identity.service";

@Module({
  imports: [MailModule],
  controllers: [IdentityController],
  providers: [IdentityService, AuthGuard],
  exports: [IdentityService, AuthGuard],
})
export class IdentityModule {}
