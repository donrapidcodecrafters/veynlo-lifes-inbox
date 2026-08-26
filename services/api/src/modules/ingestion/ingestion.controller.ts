import { Body, Controller, Post, UseGuards, UsePipes } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { IngestionService } from "./ingestion.service";
import { IngestManualDtoSchema, type IngestManualDto } from "./dto";

/**
 * Manual/share-capture ingestion entry point (§CAP-005/006 forward + quick-text
 * capture). Also doubles as the fastest way to validate the pipeline end to
 * end in environments without live Gmail OAuth configured.
 */
@Controller("v1/ingestion")
@UseGuards(AuthGuard)
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post("manual")
  @UsePipes(new ZodValidationPipe(IngestManualDtoSchema))
  async ingestManual(@CurrentUser() user: AuthenticatedUser, @Body() dto: IngestManualDto) {
    return this.ingestion.ingestManualText({
      ownerUserId: user.userId,
      householdId: null,
      subject: dto.subject,
      bodyText: dto.bodyText,
      fromAddress: dto.fromAddress,
    });
  }
}
