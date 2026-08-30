import { Module } from "@nestjs/common";
import { AnthropicExtractionService } from "./anthropic-extraction.service";
import { RiskPolicyService } from "./risk-policy.service";

@Module({
  providers: [AnthropicExtractionService, RiskPolicyService],
  exports: [AnthropicExtractionService, RiskPolicyService],
})
export class IntelligenceModule {}
