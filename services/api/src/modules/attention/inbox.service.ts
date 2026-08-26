import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/**
 * §INB-001/002 — the universal Inbox review surface. Confirming/correcting
 * here is what promotes a machine-derived candidate to a user-verified fact
 * (§AI-001/§40.2: "users own corrections" outranks model inference).
 */
@Injectable()
export class InboxService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(userId: string, filter: { reviewState?: string; category?: string } = {}) {
    const conditions = [eq(schema.inboxItems.ownerUserId, userId)];
    if (filter.reviewState) conditions.push(eq(schema.inboxItems.reviewState, filter.reviewState));
    if (filter.category) conditions.push(eq(schema.inboxItems.category, filter.category));
    return this.db.select().from(schema.inboxItems).where(and(...conditions));
  }

  async confirm(id: string, userId: string) {
    const item = await this.assertOwned(id, userId);
    await this.promoteLinkedResource(item, "verified", "confirmed");
    await this.db
      .update(schema.inboxItems)
      .set({ reviewState: "confirmed", updatedAt: new Date() })
      .where(eq(schema.inboxItems.id, id));
  }

  async archive(id: string, userId: string) {
    await this.assertOwned(id, userId);
    await this.db.update(schema.inboxItems).set({ reviewState: "archived", updatedAt: new Date() }).where(eq(schema.inboxItems.id, id));
  }

  async dismiss(id: string, userId: string) {
    await this.assertOwned(id, userId);
    await this.db.update(schema.inboxItems).set({ reviewState: "deleted", updatedAt: new Date() }).where(eq(schema.inboxItems.id, id));
  }

  async snooze(id: string, userId: string, until: Date) {
    await this.assertOwned(id, userId);
    await this.db
      .update(schema.inboxItems)
      .set({ reviewState: "snoozed", snoozedUntil: until, updatedAt: new Date() })
      .where(eq(schema.inboxItems.id, id));
  }

  private async promoteLinkedResource(
    item: typeof schema.inboxItems.$inferSelect,
    confidenceBand: "verified",
    purchaseState: "confirmed",
  ) {
    if (item.linkedResourceType === "purchase" && item.linkedResourceId) {
      await this.db
        .update(schema.purchases)
        .set({ confidenceBand, state: purchaseState, updatedAt: new Date() })
        .where(eq(schema.purchases.id, item.linkedResourceId));
    }
    // Bill/calendar-event confidence is presentational (confidenceBand lives only on Fact/InboxItem for those
    // domains today); their own "verified" flag is added when the fact/versioning layer lands.
  }

  private async assertOwned(id: string, userId: string) {
    const [item] = await this.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "INBOX_ITEM_NOT_FOUND", message: "Not found." });
    if (item.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your item." });
    return item;
  }
}
