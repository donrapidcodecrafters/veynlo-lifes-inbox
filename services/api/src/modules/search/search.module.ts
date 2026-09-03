import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module";
import { IntelligenceModule } from "../intelligence/intelligence.module";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { MemoriesModule } from "../memories/memories.module";
import { PreferencesModule } from "../preferences/preferences.module";
import { GraphModule } from "../graph/graph.module";
import { AnalyticsModule } from "../analytics/analytics.module";
import { SearchController } from "./search.controller";
import { SearchService } from "./search.service";

// MemoriesModule imported here (not the reverse — MemoriesModule/MemoriesService never import anything
// from this module) so SearchService can ask MemoriesService.relatedForQuery for SAVE-004's
// "query-based resurfacing" secondary pass alongside a real search/ask. Same one-directional shape as
// ListsModule/PublicShareModule's existing MemoriesModule imports — no cycle.
//
// §39.3 "Personal knowledge graph" — GraphModule imported the same one-directional way (GraphService/
// GraphModule import nothing from this module — just IdentityModule) so `ask()` can pull real multi-hop
// graph context into its grounding via `GraphService.resolveEntityForQuery`/`traverseFrom` — see
// search.service.ts's own doc comment on that wiring.
@Module({
  imports: [IdentityModule, IntelligenceModule, EntitlementsModule, MemoriesModule, PreferencesModule, GraphModule, AnalyticsModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
