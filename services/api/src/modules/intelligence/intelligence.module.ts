import { Module } from "@nestjs/common";
import { AnthropicExtractionService } from "./anthropic-extraction.service";

@Module({
  providers: [AnthropicExtractionService],
  exports: [AnthropicExtractionService],
})
export class IntelligenceModule {}
