import { Module } from "@nestjs/common";
import { AnthropicExtractionService } from "./anthropic-extraction.service";
import { MODEL_PROVIDER } from "./model-provider.interface";
import { RiskPolicyService } from "./risk-policy.service";

@Module({
  providers: [AnthropicExtractionService, RiskPolicyService, { provide: MODEL_PROVIDER, useExisting: AnthropicExtractionService }],
  exports: [AnthropicExtractionService, RiskPolicyService, MODEL_PROVIDER],
})
export class IntelligenceModule {}
