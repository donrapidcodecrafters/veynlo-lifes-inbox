import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNotNull, lt, lte } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { generateId, type TemporalValue } from "@veynlo/core";
import { DATABASE } from "../../database/database.module";
import { temporalToSortDate } from "../ingestion/temporal.util";
import { extractEmailAddress } from "../intelligence/deterministic-prefilter";
import type { CorrectInboxItemDto } from "./dto";

function dateTemporal(iso: string): TemporalValue {
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: null };
}

function instantTemporal(iso: string): TemporalValue {
  return { precision: "instant", instantUtc: iso, date: null, timezone: null, sourceText: null };
}

// Backend-robustness audit finding — GET /v1/inbox had no limit/cursor at all, an unbounded query that
// degrades badly for any account with a real inbox history. Same cursor-pagination shape as Timeline's/
// Documents' (`before` cursor, fetch PAGE_SIZE+1, slice+nextCursor) for consistency across list endpoints.
const INBOX_PAGE_SIZE = 30;

/**
 * §INB-001/002 — the universal Inbox review surface. Confirming/correcting
 * here is what promotes a machine-derived candidate to a user-verified fact
 * (§AI-001/§40.2: "users own corrections" outranks model inference).
 */
@Injectable()
export class InboxService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(
    userId: string,
    filter: {
      reviewState?: string;
      category?: string;
      autoFiled?: boolean;
      confidenceBand?: string;
      isDuplicate?: boolean;
      before?: string | null;
    } = {},
  ): Promise<{ items: (typeof schema.inboxItems.$inferSelect)[]; nextCursor: string | null }> {
    await this.unsnoozeExpired(userId);
    const conditions = [eq(schema.inboxItems.ownerUserId, userId)];
    if (filter.reviewState) conditions.push(eq(schema.inboxItems.reviewState, filter.reviewState));
    if (filter.category) conditions.push(eq(schema.inboxItems.category, filter.category));
    if (filter.autoFiled !== undefined) conditions.push(eq(schema.inboxItems.autoFiled, filter.autoFiled));
    if (filter.confidenceBand) conditions.push(eq(schema.inboxItems.confidenceBand, filter.confidenceBand));
    if (filter.isDuplicate !== undefined) conditions.push(eq(schema.inboxItems.isDuplicate, filter.isDuplicate));
    if (filter.before) conditions.push(lt(schema.inboxItems.createdAt, new Date(filter.before)));

    const rows = await this.db
      .select()
      .from(schema.inboxItems)
      .where(and(...conditions))
      .orderBy(desc(schema.inboxItems.createdAt))
      .limit(INBOX_PAGE_SIZE + 1);
    const hasMore = rows.length > INBOX_PAGE_SIZE;
    const items = hasMore ? rows.slice(0, INBOX_PAGE_SIZE) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.createdAt.toISOString() : null };
  }

  /**
   * INB-001 "inspect source" — the original message's recognizable-but-bounded fields (source_events
   * deliberately never stores a full body, see packages/db/src/schema/graph.ts), never the raw content
   * itself.
   */
  async inspectSource(id: string, userId: string) {
    const item = await this.assertOwned(id, userId);
    const [source] = await this.db
      .select({
        kind: schema.sourceEvents.kind,
        subjectLine: schema.sourceEvents.subjectLine,
        snippet: schema.sourceEvents.snippet,
        fromAddress: schema.sourceEvents.fromAddress,
        occurredAt: schema.sourceEvents.occurredAt,
      })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.id, item.sourceEventId))
      .limit(1);
    if (!source) throw new NotFoundException({ code: "SOURCE_NOT_FOUND", message: "The original source is no longer available." });
    return source;
  }

  /** INB-001/MAIL-006 "block sender" — future messages from this exact address are filed with no inbox item created at all (IngestionService.classifyAndExtract). Doesn't touch anything already filed. */
  async blockSender(id: string, userId: string) {
    const address = await this.senderAddressFor(id, userId);
    await this.upsertSenderRule(userId, address, "block", null);
  }

  /** MAIL-006 "always treat messages from this sender as X" — forces future messages from this exact address into one category, skipping AI classification for them entirely. */
  async setSenderCategoryRule(id: string, userId: string, category: string) {
    const address = await this.senderAddressFor(id, userId);
    await this.upsertSenderRule(userId, address, "category_override", category);
  }

  async listSenderRules(userId: string) {
    return this.db.select().from(schema.senderRules).where(eq(schema.senderRules.ownerUserId, userId));
  }

  async deleteSenderRule(ruleId: string, userId: string) {
    await this.db.delete(schema.senderRules).where(and(eq(schema.senderRules.id, ruleId), eq(schema.senderRules.ownerUserId, userId)));
  }

  private async senderAddressFor(inboxItemId: string, userId: string): Promise<string> {
    const item = await this.assertOwned(inboxItemId, userId);
    const [source] = await this.db
      .select({ fromAddress: schema.sourceEvents.fromAddress })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.id, item.sourceEventId))
      .limit(1);
    if (!source?.fromAddress) {
      throw new BadRequestException({ code: "NO_SENDER", message: "This item has no sender to create a rule for." });
    }
    return extractEmailAddress(source.fromAddress);
  }

  private async upsertSenderRule(ownerUserId: string, senderAddress: string, action: string, categoryOverride: string | null): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.senderRules.id })
      .from(schema.senderRules)
      .where(and(eq(schema.senderRules.ownerUserId, ownerUserId), eq(schema.senderRules.senderAddress, senderAddress)))
      .limit(1);
    if (existing) {
      await this.db.update(schema.senderRules).set({ action, categoryOverride }).where(eq(schema.senderRules.id, existing.id));
    } else {
      await this.db.insert(schema.senderRules).values({ id: generateId("senderRule"), ownerUserId, senderAddress, action, categoryOverride });
    }
  }

  /**
   * Correction to this file's own earlier comment (and docs/ROADMAP.md's Home-dashboard entry): a global
   * `inbox-unsnooze` worker tick already does this exact flip every 15 minutes (worker-main.ts,
   * queue-producer.service.ts) — this was NOT actually a missing fix for inbox_items. This per-user call
   * is a genuine but modest improvement on top of that: it makes the flip immediately consistent at read
   * time instead of waiting up to 15 minutes for the next tick, at the cost of one extra UPDATE per
   * list() call. Kept for that reason, not because the worker tick didn't exist.
   */
  private async unsnoozeExpired(userId: string): Promise<void> {
    await this.db
      .update(schema.inboxItems)
      .set({ reviewState: "new", snoozedUntil: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.inboxItems.ownerUserId, userId),
          eq(schema.inboxItems.reviewState, "snoozed"),
          isNotNull(schema.inboxItems.snoozedUntil),
          lte(schema.inboxItems.snoozedUntil, new Date()),
        ),
      );
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
    let result: unknown;
    switch (item.linkedResourceType) {
      case "purchase":
        result = await this.correctPurchase(item.linkedResourceId, dto);
        break;
      case "bill":
        result = await this.correctBill(item.linkedResourceId, dto);
        break;
      case "calendar_event":
        result = await this.correctCalendarEvent(item.linkedResourceId, dto);
        break;
      case "shipment":
        result = await this.correctShipment(item.linkedResourceId, dto);
        break;
      case "warranty":
        result = await this.correctWarranty(item.linkedResourceId, dto);
        break;
      case "subscription":
        result = await this.correctSubscription(item.linkedResourceId, dto);
        break;
      default:
        throw new BadRequestException({
          code: "UNSUPPORTED_RESOURCE_TYPE",
          message: `Corrections aren't supported for "${item.linkedResourceType}" yet.`,
        });
    }
    // SECURITY.md "consumer-side actions aren't all audited yet" — corrections were one of the named gaps.
    // One record per correct() call regardless of which linkedResourceType it dispatched to, since the DTO
    // itself (the fields actually being changed) is the meaningful "what changed" payload here.
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: userId,
      action: "inbox.correct",
      resourceType: item.linkedResourceType,
      resourceId: item.linkedResourceId,
      afterJson: dto,
      result: "success",
    });
    return result;
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

  /** Spans two tables — serviceLabel/cadence/amount live on the recurring stream, cancellation info on the subscription itself. */
  private async correctSubscription(subscriptionId: string, dto: CorrectInboxItemDto) {
    const [subscription] = await this.db
      .select({ recurringStreamId: schema.subscriptions.recurringStreamId })
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.id, subscriptionId))
      .limit(1);
    if (!subscription) return;

    const streamPatch: Partial<typeof schema.recurringStreams.$inferInsert> = { updatedAt: new Date() };
    let hasStreamPatch = false;
    if (dto.serviceLabel !== undefined) {
      streamPatch.serviceLabel = dto.serviceLabel;
      hasStreamPatch = true;
    }
    if (dto.cadence !== undefined) {
      streamPatch.cadence = dto.cadence;
      hasStreamPatch = true;
    }
    if (dto.typicalAmountMinorUnits !== undefined) {
      streamPatch.typicalAmountMinorUnits = dto.typicalAmountMinorUnits;
      hasStreamPatch = true;
    }
    if (dto.typicalAmountCurrency !== undefined) {
      streamPatch.typicalAmountCurrency = dto.typicalAmountCurrency;
      hasStreamPatch = true;
    }
    if (hasStreamPatch) {
      await this.db.update(schema.recurringStreams).set(streamPatch).where(eq(schema.recurringStreams.id, subscription.recurringStreamId));
    }

    if (dto.cancellationInstructionsUrl !== undefined) {
      await this.db
        .update(schema.subscriptions)
        .set({ cancellationInstructionsUrl: dto.cancellationInstructionsUrl, updatedAt: new Date() })
        .where(eq(schema.subscriptions.id, subscriptionId));
    }
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
