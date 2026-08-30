import { Controller, Get, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { MetricsService } from "./metrics.service";

/** Scraped by a metrics collector every ~15-30s from every task — must never count against the general
 * API rate limit, matching the identical reasoning on HealthController. No AuthGuard: a Prometheus-style
 * `/metrics` endpoint is conventionally unauthenticated (scrapers don't carry a user session), and nothing
 * exposed here is per-user data — request counts/latencies by route, plus process-level stats. */
@Controller("metrics")
@SkipThrottle()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async metricsEndpoint(@Res() res: FastifyReply) {
    res.header("content-type", this.metrics.contentType);
    res.send(await this.metrics.getMetrics());
  }
}
