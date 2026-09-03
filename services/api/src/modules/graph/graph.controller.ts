import { Controller, Get, Inject, Param, Query, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../../common/auth.guard";
import { CurrentUser } from "../../common/current-user.decorator";
import type { AuthenticatedUser } from "../../common/auth.guard";
import { GraphService } from "./graph.service";

/** §39.3 "Personal knowledge graph" — default hop count for `GET /v1/entities/:id/graph` when the caller
 * doesn't specify one; matches the depth `SearchService.ask()` itself uses when pulling graph context into
 * grounding (see search.service.ts). `GraphService.traverseFrom` clamps this regardless of what's passed. */
const DEFAULT_GRAPH_HOPS = 2;

@Controller("v1/entities")
@UseGuards(AuthGuard)
export class GraphController {
  constructor(@Inject(GraphService) private readonly graph: GraphService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.graph.listEntities(user.userId);
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.graph.entityDetail(id, user.userId);
  }

  /** §39.3 multi-hop reasoning — "what else is connected to this merchant/person," "show me everything
   * related to this trip across purchases/documents/people." `hops` is caller-suggested only; the service
   * itself enforces the real ceiling. */
  @Get(":id/graph")
  traverse(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Query("hops") hops?: string) {
    const parsed = hops ? Number.parseInt(hops, 10) : DEFAULT_GRAPH_HOPS;
    return this.graph.traverseFrom(id, user.userId, Number.isFinite(parsed) ? parsed : DEFAULT_GRAPH_HOPS);
  }
}
