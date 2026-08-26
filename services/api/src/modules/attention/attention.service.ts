import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

@Injectable()
export class AttentionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** HOME-001/004 — the ranked "Needs You" queue plus the caught-up/degraded state computation. */
  async home(userId: string) {
    const items = await this.db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.ownerUserId, userId), eq(schema.attentionItems.resolved, false)))
      .orderBy(asc(schema.attentionItems.dueAtSort));

    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, userId));
    const unhealthyConnections = connections.filter((c) => !["healthy", "initializing"].includes(c.health));

    return {
      items,
      caughtUp: items.length === 0,
      degraded: unhealthyConnections.length > 0,
      unhealthyConnections: unhealthyConnections.map((c) => ({ id: c.id, provider: c.provider, health: c.health })),
    };
  }

  async resolve(id: string, userId: string) {
    await this.assertOwned(id, userId);
    await this.db.update(schema.attentionItems).set({ resolved: true, updatedAt: new Date() }).where(eq(schema.attentionItems.id, id));
  }

  async dismiss(id: string, userId: string, reason: string) {
    await this.assertOwned(id, userId);
    await this.db
      .update(schema.attentionItems)
      .set({ resolved: true, dismissedReason: reason, updatedAt: new Date() })
      .where(eq(schema.attentionItems.id, id));
  }

  private async assertOwned(id: string, userId: string) {
    const [item] = await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "ATTENTION_ITEM_NOT_FOUND", message: "Not found." });
    if (item.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your item." });
    return item;
  }
}
