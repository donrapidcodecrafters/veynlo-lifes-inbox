import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { AttentionModule } from "../attention/attention.module";
import { FinanceController } from "./finance.controller";
import { FinanceService } from "./finance.service";

@Module({
  // AttentionModule — FIN-004's detectAnomalousTransactions files duplicate/unusual-charge attention
  // items through AttentionService.fileIfNew (the same dedup path every other deadline scan uses) rather
  // than duplicating that logic. One-directional: AttentionModule's own imports (Identity/Household/
  // Connectors/Schedule/Notifications) never reach back into FinanceModule, so this doesn't create a cycle.
  imports: [IdentityModule, AttentionModule],
  controllers: [FinanceController],
  providers: [FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
