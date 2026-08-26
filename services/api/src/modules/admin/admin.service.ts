import { Inject, Injectable } from "@nestjs/common";
import { desc, eq, ne } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

@Injectable()
export class AdminService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findUserByEmail(email: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    if (!user) return null;
    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, user.id));
    const entitlements = await this.db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, user.id));
    // Support tooling intentionally exposes only metadata (status, plan, connector health) — never message/document
    // bodies or financial details (§ "ADMIN SUPPORT ACCESS": "prefer metadata... redacted views").
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      connections: connections.map((c) => ({ id: c.id, provider: c.provider, health: c.health, lastSuccessfulSyncAt: c.lastSuccessfulSyncAt })),
      entitlements,
    };
  }

  async connectorHealthSummary() {
    const connections = await this.db.select().from(schema.connections).where(ne(schema.connections.health, "disconnected"));
    const byHealth: Record<string, number> = {};
    for (const c of connections) byHealth[c.health] = (byHealth[c.health] ?? 0) + 1;
    return { total: connections.length, byHealth };
  }

  async recentAuditEvents(limit = 50) {
    return this.db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.occurredAt)).limit(limit);
  }
}
