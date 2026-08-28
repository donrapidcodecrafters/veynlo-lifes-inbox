import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import type { TemporalValue } from "@veynlo/core";
import { DATABASE } from "../../database/database.module";
import { temporalToSortDate } from "../ingestion/temporal.util";
import type { CorrectInboxItemDto } from "./dto";

function dateTemporal(iso: string): TemporalValue {
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: null };
}

function instantTemporal(iso: string): TemporalValue {
  return { precision: "instant", instantUtc: iso, date: null, timezone: null, sourceText: null };
}

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

  /**
   * §AI-001/§40.2 "users own corrections outranks model inference" — fixes a wrong extraction on the
   * *linked domain record* (purchase/bill/calendar_event/shipment), not the inbox item itself, since
   * inbox_items carries only a summary/pointer, never the actual structured fields (see the module's
   * class doc comment). Deliberately doesn't touch reviewState — correcting and confirming are separate
   * actions, so a user can fix a field without that implicitly counting as verifying the whole item.
   */
  async correct(id: string, userId: string, dto: CorrectInboxItemDto) {
    const item = await this.assertOwned(id, userId);
    if (!item.linkedResourceId) {
      throw new BadRequestException({ code: "NOTHING_TO_CORRECT", message: "This item has no linked record to correct." });
    }
    switch (item.linkedResourceType) {
      case "purchase":
        return this.correctPurchase(item.linkedResourceId, dto);
      case "bill":
        return this.correctBill(item.linkedResourceId, dto);
      case "calendar_event":
        return this.correctCalendarEvent(item.linkedResourceId, dto);
      case "shipment":
        return this.correctShipment(item.linkedResourceId, dto);
      case "warranty":
        return this.correctWarranty(item.linkedResourceId, dto);
      default:
        throw new BadRequestException({
          code: "UNSUPPORTED_RESOURCE_TYPE",
          message: `Corrections aren't supported for "${item.linkedResourceType}" yet.`,
        });
    }
  }

  private async correctPurchase(purchaseId: string, dto: CorrectInboxItemDto) {
    const patch: Partial<typeof schema.purchases.$inferInsert> = { updatedAt: new Date() };
    if (dto.orderNumber !== undefined) patch.orderNumber = dto.orderNumber;
    if (dto.totalMinorUnits !== undefined) patch.totalMinorUnits = dto.totalMinorUnits;
    if (dto.totalCurrency !== undefined) patch.totalCurrency = dto.totalCurrency;
    if (dto.taxMinorUnits !== undefined) patch.taxMinorUnits = dto.taxMinorUnits;
    if (dto.shippingMinorUnits !== undefined) patch.shippingMinorUnits = dto.shippingMinorUnits;
    if (dto.purchaseDateIso !== undefined) {
      const temporal = dateTemporal(dto.purchaseDateIso);
      patch.purchaseDate = temporal;
      patch.purchaseDateSort = temporalToSortDate(temporal);
    }
    await this.db.update(schema.purchases).set(patch).where(eq(schema.purchases.id, purchaseId));
  }

  private async correctBill(billId: string, dto: CorrectInboxItemDto) {
    const patch: Partial<typeof schema.bills.$inferInsert> = { updatedAt: new Date() };
    if (dto.billerLabel !== undefined) patch.billerLabel = dto.billerLabel;
    if (dto.amountDueMinorUnits !== undefined) patch.amountDueMinorUnits = dto.amountDueMinorUnits;
    if (dto.amountDueCurrency !== undefined) patch.amountDueCurrency = dto.amountDueCurrency;
    if (dto.autopayBelieved !== undefined) patch.autopayBelieved = dto.autopayBelieved;
    if (dto.dueDateIso !== undefined) {
      const temporal = dateTemporal(dto.dueDateIso);
      patch.dueDate = temporal;
      patch.dueDateSort = temporalToSortDate(temporal);
    }
    await this.db.update(schema.bills).set(patch).where(eq(schema.bills.id, billId));
  }

  private async correctCalendarEvent(eventId: string, dto: CorrectInboxItemDto) {
    const patch: Partial<typeof schema.calendarEvents.$inferInsert> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.location !== undefined) patch.location = dto.location;
    if (dto.isAllDay !== undefined) patch.isAllDay = dto.isAllDay;
    // isAllDay (new value if provided, else whatever's already stored) decides whether start/end are
    // date-only or a specific instant — an all-day event corrected to a specific time would be nonsensical.
    const allDay = dto.isAllDay ?? (await this.currentIsAllDay(eventId));
    if (dto.startIso !== undefined) {
      const temporal = allDay ? dateTemporal(dto.startIso) : instantTemporal(dto.startIso);
      patch.start = temporal;
      patch.startSort = temporalToSortDate(temporal);
    }
    if (dto.endIso !== undefined) {
      patch.end = dto.endIso === null ? null : allDay ? dateTemporal(dto.endIso) : instantTemporal(dto.endIso);
    }
    await this.db.update(schema.calendarEvents).set(patch).where(eq(schema.calendarEvents.id, eventId));
  }

  private async currentIsAllDay(eventId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ isAllDay: schema.calendarEvents.isAllDay })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, eventId))
      .limit(1);
    return row?.isAllDay ?? false;
  }

  private async correctShipment(shipmentId: string, dto: CorrectInboxItemDto) {
    const patch: Partial<typeof schema.shipments.$inferInsert> = { updatedAt: new Date() };
    if (dto.carrier !== undefined) patch.carrier = dto.carrier;
    if (dto.trackingNumber !== undefined) patch.trackingNumber = dto.trackingNumber;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.estimatedDeliveryIso !== undefined) {
      patch.estimatedDelivery = dto.estimatedDeliveryIso === null ? null : dateTemporal(dto.estimatedDeliveryIso);
    }
    await this.db.update(schema.shipments).set(patch).where(eq(schema.shipments.id, shipmentId));
  }

  private async correctWarranty(warrantyId: string, dto: CorrectInboxItemDto) {
    const patch: Partial<typeof schema.warranties.$inferInsert> = { updatedAt: new Date() };
    if (dto.productLabel !== undefined) patch.productLabel = dto.productLabel;
    if (dto.warrantyLengthMonths !== undefined) patch.warrantyLengthMonths = dto.warrantyLengthMonths;
    if (dto.registrationConfirmed !== undefined) patch.registrationConfirmed = dto.registrationConfirmed;
    if (dto.expirationDateIso !== undefined) {
      const temporal = dateTemporal(dto.expirationDateIso);
      patch.expirationDate = temporal;
      patch.expirationDateSort = temporalToSortDate(temporal);
    }
    await this.db.update(schema.warranties).set(patch).where(eq(schema.warranties.id, warrantyId));
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
