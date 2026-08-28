import { Inject, Injectable } from "@nestjs/common";
import { asc, eq, inArray, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";

@Injectable()
export class CommerceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly households: HouseholdService,
  ) {}

  /**
   * FAM-006 enforcement — a caregiver delegated "commerce:read" on a household sees that household's
   * purchases/bills/returns/subscriptions/warranties alongside their own, not just their own. Returns a
   * Drizzle condition ORing the caller's own rows with any row belonging to a household they've been
   * delegated commerce:read on; the household branch is omitted entirely when there are none, since
   * `inArray` with an empty array is invalid SQL.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const householdIds = await this.households.delegatedHouseholdIds(userId, "commerce:read");
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  async purchases(userId: string) {
    return this.db.select().from(schema.purchases).where(await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId));
  }

  async purchaseDetail(purchaseId: string, userId: string) {
    const [purchase] = await this.db
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchaseId))
      .limit(1);
    if (!purchase) return null;
    if (purchase.ownerUserId !== userId) {
      const householdIds = purchase.householdId ? await this.households.delegatedHouseholdIds(userId, "commerce:read") : [];
      if (!purchase.householdId || !householdIds.includes(purchase.householdId)) return null;
    }
    const lines = await this.db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
    const returns = await this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId));
    const shipments = await this.db.select().from(schema.shipments).where(eq(schema.shipments.purchaseId, purchaseId));
    return { purchase, lines, returns, shipments };
  }

  async returns(userId: string) {
    return this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId))
      .orderBy(asc(schema.returnCases.deadlineSort));
  }

  async subscriptions(userId: string) {
    return this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.recurringStreams.ownerUserId, schema.recurringStreams.householdId));
  }

  async bills(userId: string) {
    return this.db
      .select({ bill: schema.bills, stream: schema.recurringStreams })
      .from(schema.bills)
      .leftJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.bills.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.bills.ownerUserId, schema.bills.householdId))
      .orderBy(asc(schema.bills.dueDateSort));
  }

  async warranties(userId: string) {
    return this.db
      .select()
      .from(schema.warranties)
      .where(await this.ownerOrDelegatedHousehold(userId, schema.warranties.ownerUserId, schema.warranties.householdId))
      .orderBy(asc(schema.warranties.expirationDateSort));
  }
}
