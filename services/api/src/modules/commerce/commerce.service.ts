import { Inject, Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

@Injectable()
export class CommerceService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  purchases(userId: string) {
    return this.db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, userId));
  }

  async purchaseDetail(purchaseId: string, userId: string) {
    const [purchase] = await this.db
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchaseId))
      .limit(1);
    if (!purchase || purchase.ownerUserId !== userId) return null;
    const lines = await this.db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
    const returns = await this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId));
    const shipments = await this.db.select().from(schema.shipments).where(eq(schema.shipments.purchaseId, purchaseId));
    return { purchase, lines, returns, shipments };
  }

  returns(userId: string) {
    return this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(eq(schema.purchases.ownerUserId, userId))
      .orderBy(asc(schema.returnCases.deadlineSort));
  }

  subscriptions(userId: string) {
    return this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(eq(schema.recurringStreams.ownerUserId, userId));
  }

  bills(userId: string) {
    return this.db
      .select({ bill: schema.bills, stream: schema.recurringStreams })
      .from(schema.bills)
      .leftJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.bills.recurringStreamId))
      .where(eq(schema.bills.ownerUserId, userId))
      .orderBy(asc(schema.bills.dueDateSort));
  }
}
