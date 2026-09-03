import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { sql } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/**
 * Hit by the load balancer every ~30s from every task — must never count
 * against the general API rate limit, and /ready must stay cheap (one trivial
 * query) rather than exercising every downstream dependency on each check.
 */
@Controller("health")
@SkipThrottle()
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ code: "NOT_READY", message: "Database connection is not ready." });
    }
    return { status: "ok" };
  }
}
