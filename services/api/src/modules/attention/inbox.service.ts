import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { generateId, type TemporalValue } from "@veynlo/core";
import { DATABASE } from "../../database/database.module";
import { temporalToSortDate } from "../ingestion/temporal.util";
import { CalendarWriteBackService } from "../connectors/calendar-write-back.service";
import { ConflictService } from "../schedule/conflict.service";
import { normalizeSenderDomain, extractEmailAddress } from "../intelligence/deterministic-prefilter";
import { resolvePriceAdjustmentPolicy, priceAdjustmentDeadline, daysUntil } from "../commerce/price-adjustment-policy";
import { SearchIndexService } from "../search/search-index.service";
import type { CorrectInboxItemDto, AddToCalendarDto, ApplyRescheduleDto, AddSenderRuleDto, SenderRuleAction } from "./dto";

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
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CalendarWriteBackService) private readonly calendarWriteBack: CalendarWriteBackService,
    @Inject(ConflictService) private readonly conflicts: ConflictService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional
    // `new InboxService(...)` test construction keeps compiling unchanged.
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  async list(userId: string, filter: { reviewState?: string; category?: string } = {}) {
    const conditions = [eq(schema.inboxItems.ownerUserId, userId)];
    if (filter.reviewState) conditions.push(eq(schema.inboxItems.reviewState, filter.reviewState));
    if (filter.category) conditions.push(eq(schema.inboxItems.category, filter.category));
    const items = await this.db.select().from(schema.inboxItems).where(and(...conditions));

    // RET-004 "Policy engine ... deadline calculator" — a price_adjustment inbox item's `summary` already
    // states the price drop, but never a deadline or the policy's own confidence (the exact gap the RET-004
    // audit named). `linkedResourceId` on this category is the ORIGINAL, higher-priced purchase (see
    // IngestionService.extractReceipt's price-adjustment block), so its own merchantId/purchaseDateSort is
    // exactly what the deadline calculator needs — same read this same data backs on the purchase-detail
    // banner (CommerceService.purchaseDetail's priceAdjustmentPolicy field).
    const priceAdjustmentIds = items.filter((i) => i.category === "price_adjustment" && i.linkedResourceType === "purchase" && i.linkedResourceId).map((i) => i.linkedResourceId!);
    const deadlinesByPurchaseId = priceAdjustmentIds.length > 0 ? await this.priceAdjustmentDeadlinesByPurchaseId(priceAdjustmentIds, userId) : new Map();

    // §52.1 "voice note" transcription — a voice_note inbox item's `summary` is set once, at capture time
    // ("New voice note captured"), and never updated; the client has no other way to learn whether
    // transcription later succeeded, is still pending, or genuinely couldn't produce anything, short of
    // reading `source_events.transcript`/`processingState` directly. Mirrors the price-adjustment
    // enrichment above (a targeted, category-scoped join onto the plain `inboxItems` rows, not a schema
    // change to that table) — `pending: true` is what mobile polls on until it flips to false.
    const voiceNoteSourceEventIds = items.filter((i) => i.category === "voice_note" && i.sourceEventId).map((i) => i.sourceEventId!);
    const voiceNoteInfoBySourceEventId =
      voiceNoteSourceEventIds.length > 0 ? await this.voiceNoteInfoBySourceEventId(voiceNoteSourceEventIds) : new Map();

    return items.map((item) => {
      let enriched: typeof item & { priceAdjustment?: unknown; voiceNote?: { transcript: string | null; pending: boolean } } = item;
      if (item.category === "price_adjustment" && item.linkedResourceId) {
        const priceAdjustment = deadlinesByPurchaseId.get(item.linkedResourceId);
        if (priceAdjustment) enriched = { ...enriched, priceAdjustment };
      }
      if (item.category === "voice_note" && item.sourceEventId) {
        const voiceNote = voiceNoteInfoBySourceEventId.get(item.sourceEventId);
        if (voiceNote) enriched = { ...enriched, voiceNote };
      }
      return enriched;
    });
  }

  private async voiceNoteInfoBySourceEventId(sourceEventIds: string[]) {
    const rows = await this.db
      .select({ id: schema.sourceEvents.id, transcript: schema.sourceEvents.transcript, processingState: schema.sourceEvents.processingState })
      .from(schema.sourceEvents)
      .where(inArray(schema.sourceEvents.id, sourceEventIds));
    const map = new Map<string, { transcript: string | null; pending: boolean }>();
    for (const row of rows) {
      // "understanding" is the only state a still-pending voice note sits in (see IngestionService.
      // ingestVoiceNote/processVoiceTranscription) — every other state (filed/needs_review) means
      // transcription has already run, whether or not it produced a usable transcript.
      map.set(row.id, { transcript: row.transcript, pending: row.processingState === "understanding" });
    }
    return map;
  }

  private async priceAdjustmentDeadlinesByPurchaseId(purchaseIds: string[], userId: string) {
    const purchases = await this.db
      .select({ id: schema.purchases.id, merchantId: schema.purchases.merchantId, purchaseDateSort: schema.purchases.purchaseDateSort })
      .from(schema.purchases)
      .where(inArray(schema.purchases.id, purchaseIds));
    const map = new Map<
      string,
      { deadline: string; daysLeft: number; windowDays: number; policyConfidence: string; policySourceNote: string | null }
    >();
    for (const p of purchases) {
      if (!p.purchaseDateSort) continue;
      const policy = await resolvePriceAdjustmentPolicy(this.db, p.merchantId, userId);
      const deadline = priceAdjustmentDeadline(p.purchaseDateSort, policy.windowDays);
      map.set(p.id, {
        deadline: deadline.toISOString(),
        daysLeft: daysUntil(deadline),
        windowDays: policy.windowDays,
        policyConfidence: policy.confidence,
        policySourceNote: policy.sourceNote,
      });
    }
    return map;
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
   * CAL-002 "offers Add to calendar with chosen destination and reminder defaults" — the real destination-
   * choice action behind the "add_to_calendar" suggestedAction, which previously did nothing a plain
   * `confirm` didn't already do. `destinationConnectionId: null` means "keep in Life Inbox only" (the
   * event already exists locally — see IngestionService.extractCalendarEvent — so there's nothing to do
   * beyond that); a non-null id pushes it to that write-back-enabled connected calendar via
   * CalendarWriteBackService, which never throws on a provider-side failure (see its own doc comment) —
   * this action always ends by confirming the item, whether or not the push itself succeeded, since the
   * user's actual choice (destination + reminder) was still recorded either way.
   */
  async addToCalendar(id: string, userId: string, dto: AddToCalendarDto): Promise<{ pushed: boolean }> {
    const item = await this.assertOwned(id, userId);
    if (item.linkedResourceType !== "calendar_event" || !item.linkedResourceId) {
      throw new BadRequestException({ code: "NOT_A_CALENDAR_EVENT", message: "This item isn't a discovered calendar event." });
    }
    if (dto.reminderMinutesBefore !== undefined) {
      await this.db
        .update(schema.calendarEvents)
        .set({ reminderMinutesBefore: dto.reminderMinutesBefore, updatedAt: new Date() })
        .where(eq(schema.calendarEvents.id, item.linkedResourceId));
    }
    let pushed = false;
    if (dto.destinationConnectionId) {
      const result = await this.calendarWriteBack.pushEvent({ eventId: item.linkedResourceId, ownerUserId: userId, connectionId: dto.destinationConnectionId });
      pushed = result.pushed;
    }
    await this.confirm(id, userId);
    return { pushed };
  }

  /**
   * CAL-004 "offer, don't auto-apply" — the "apply_change" action behind a reschedule-reconciliation
   * offer that `IngestionService.extractCalendarEvent` files when a second email about the same appointment
   * proposes a new date/time/location but no trusted rule (yet) covers its sender domain. Applies exactly
   * the fields that were proposed at the time the email arrived (not whatever the event looks like now —
   * the proposal row is a snapshot), re-runs CAL-003 conflict detection since the event's own time is
   * actually changing here, and re-pushes to a connected write-back calendar if one was already set,
   * mirroring `correctCalendarEvent`'s identical write-back re-sync. `dto.trustSender` is the "Always trust
   * reschedule emails like this one" opt-in reachable right from the offered-change item — it inserts a
   * `calendarRescheduleTrustedRules` row for the proposal's sender domain so the *next* reschedule from
   * this sender auto-applies instead of being offered again.
   */
  async applyRescheduleChange(id: string, userId: string, dto: ApplyRescheduleDto): Promise<{ trustedSenderAdded: boolean }> {
    const item = await this.assertOwned(id, userId);
    if (item.linkedResourceType !== "calendar_event" || !item.linkedResourceId) {
      throw new BadRequestException({ code: "NOT_A_CALENDAR_EVENT", message: "This item isn't a proposed calendar reschedule." });
    }
    const [proposal] = await this.db
      .select()
      .from(schema.calendarRescheduleProposals)
      .where(eq(schema.calendarRescheduleProposals.inboxItemId, id))
      .orderBy(desc(schema.calendarRescheduleProposals.createdAt))
      .limit(1);
    if (!proposal) {
      throw new BadRequestException({ code: "NO_PROPOSED_CHANGE", message: "This item has no proposed reschedule to apply." });
    }

    await this.db
      .update(schema.calendarEvents)
      .set({
        start: proposal.proposedStart,
        startSort: temporalToSortDate(proposal.proposedStart),
        isAllDay: proposal.proposedIsAllDay,
        location: proposal.proposedLocation,
        updatedAt: new Date(),
      })
      .where(eq(schema.calendarEvents.id, proposal.calendarEventId));

    // CAL-003 — the event's own time just actually changed (unlike the "offer" step itself, which never
    // touched the row), so this is the first point a real overlap conflict against it can be detected.
    try {
      await this.conflicts.detectOverlaps(proposal.calendarEventId, userId);
    } catch {
      // Best-effort, matching IngestionService.extractCalendarEvent's identical stance — never block
      // applying the user's own explicit choice because conflict detection itself failed.
    }

    const [event] = await this.db
      .select({ writeBackConnectionId: schema.calendarEvents.writeBackConnectionId })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, proposal.calendarEventId))
      .limit(1);
    if (event?.writeBackConnectionId) {
      await this.calendarWriteBack.pushEvent({ eventId: proposal.calendarEventId, ownerUserId: userId, connectionId: event.writeBackConnectionId });
    }

    let trustedSenderAdded = false;
    if (dto.trustSender && proposal.senderDomain) {
      await this.db
        .insert(schema.calendarRescheduleTrustedRules)
        .values({ id: generateId("calendarRescheduleTrustedRule"), ownerUserId: userId, senderDomain: proposal.senderDomain })
        .onConflictDoNothing({ target: [schema.calendarRescheduleTrustedRules.ownerUserId, schema.calendarRescheduleTrustedRules.senderDomain] });
      trustedSenderAdded = true;
    }

    await this.confirm(id, userId);
    return { trustedSenderAdded };
  }

  /**
   * CAL-003 "email-vs-calendar date disagreement" — the user's own resolve action behind the
   * `["use_email_date", "keep_calendar_date", "dismiss"]` item `IngestionService.checkCalendarDateDisagreement`
   * files (`dismiss` reuses the generic `dismiss` action below — no special handling needed for it here).
   * The item's `linkedResourceId` is a `schedule_conflicts` row (kind `email_calendar_date_disagreement`)
   * whose `involvedEventIds` are stored in a fixed, NEVER-sorted order — `[0]` is the email-discovered
   * event, `[1]` is the pre-existing, different-source calendar event (see
   * `ConflictService.recordDateDisagreement`'s own doc comment on why this one kind is directional).
   *
   * "use_email_date" reuses `correctCalendarEvent` (rather than a bespoke update) so the calendar-side
   * event's date changes through the exact same code path as a manual user correction — including its
   * write-back re-push to a connected calendar if one is already set. "keep_calendar_date" is deliberately a
   * no-op on both rows: this doesn't try to merge/delete the email-discovered duplicate (CAL-001's
   * duplicate-collapse is a separate, display-layer concern) — it only settles the disagreement itself.
   * Either choice resolves the underlying conflict via `ConflictService.resolveConflict` (whose
   * owner-of-either-event permission check already covers this kind generically) and confirms the item.
   */
  async resolveDateDisagreement(id: string, userId: string, choice: "use_email_date" | "keep_calendar_date"): Promise<void> {
    const item = await this.assertOwned(id, userId);
    if (item.linkedResourceType !== "schedule_conflict" || !item.linkedResourceId) {
      throw new BadRequestException({ code: "NOT_A_DATE_DISAGREEMENT", message: "This item isn't a date-disagreement conflict." });
    }
    const [conflict] = await this.db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, item.linkedResourceId)).limit(1);
    if (!conflict || conflict.kind !== "email_calendar_date_disagreement" || conflict.involvedEventIds.length !== 2) {
      throw new BadRequestException({ code: "NOT_A_DATE_DISAGREEMENT", message: "This item isn't a date-disagreement conflict." });
    }
    const [emailEventId, calendarEventId] = conflict.involvedEventIds;

    if (choice === "use_email_date") {
      const [emailEvent] = await this.db.select({ start: schema.calendarEvents.start, isAllDay: schema.calendarEvents.isAllDay }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, emailEventId!)).limit(1);
      const emailStartIso = emailEvent ? (emailEvent.start.precision === "date" ? emailEvent.start.date : emailEvent.start.instantUtc) : null;
      if (emailEvent && emailStartIso) {
        await this.correctCalendarEvent(calendarEventId!, { isAllDay: emailEvent.isAllDay, startIso: emailStartIso });
      }
    }
    // "keep_calendar_date" — no row changes; the disagreement is simply settled in the calendar's favor.

    await this.conflicts.resolveConflict(conflict.id, userId);
    await this.confirm(id, userId);
  }

  /** CAL-004 trusted-reschedule-rule settings surface (web + mobile) — list/add/remove, independent of any
   * specific offered inbox item (the item-level "Always trust..." checkbox is `applyRescheduleChange`'s
   * `trustSender` flag above; this is the standalone management view). */
  async listTrustedRescheduleRules(userId: string) {
    return this.db
      .select()
      .from(schema.calendarRescheduleTrustedRules)
      .where(eq(schema.calendarRescheduleTrustedRules.ownerUserId, userId))
      .orderBy(desc(schema.calendarRescheduleTrustedRules.createdAt));
  }

  async addTrustedRescheduleRule(userId: string, rawSenderDomain: string): Promise<{ id: string; senderDomain: string }> {
    const senderDomain = normalizeSenderDomain(rawSenderDomain);
    if (!senderDomain) {
      throw new BadRequestException({ code: "INVALID_SENDER_DOMAIN", message: "Enter a valid domain, e.g. \"united.com\"." });
    }
    const id = generateId("calendarRescheduleTrustedRule");
    await this.db
      .insert(schema.calendarRescheduleTrustedRules)
      .values({ id, ownerUserId: userId, senderDomain })
      .onConflictDoNothing({ target: [schema.calendarRescheduleTrustedRules.ownerUserId, schema.calendarRescheduleTrustedRules.senderDomain] });
    return { id, senderDomain };
  }

  async removeTrustedRescheduleRule(id: string, userId: string): Promise<void> {
    const [rule] = await this.db.select().from(schema.calendarRescheduleTrustedRules).where(eq(schema.calendarRescheduleTrustedRules.id, id)).limit(1);
    if (!rule) throw new NotFoundException({ code: "RULE_NOT_FOUND", message: "Trusted-sender rule not found." });
    if (rule.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your rule." });
    await this.db.delete(schema.calendarRescheduleTrustedRules).where(eq(schema.calendarRescheduleTrustedRules.id, id));
  }

  /** MAIL-006 "User sender rules" settings surface (web + mobile) — standalone list/add/remove, independent
   * of any specific Inbox item, mirroring listTrustedRescheduleRules' identical shape above. */
  async listSenderRules(userId: string) {
    return this.db.select().from(schema.senderRules).where(eq(schema.senderRules.ownerUserId, userId)).orderBy(desc(schema.senderRules.createdAt));
  }

  /** Add-or-update: re-submitting the same sender with a different action replaces the rule rather than
   * erroring on the unique index, so a user correcting their own earlier choice ("actually, ignore this
   * one instead of always-bills") doesn't need to remove-then-add. */
  async addSenderRule(userId: string, dto: AddSenderRuleDto): Promise<{ id: string; senderDomain: string | null; senderEmail: string | null; action: SenderRuleAction }> {
    const senderDomain = dto.senderDomain ? normalizeSenderDomain(dto.senderDomain) : null;
    const senderEmail = dto.senderEmail ? extractEmailAddress(dto.senderEmail) : null;
    if (dto.senderDomain && !senderDomain) {
      throw new BadRequestException({ code: "INVALID_SENDER_DOMAIN", message: 'Enter a valid domain, e.g. "acmehospital.org".' });
    }
    if (dto.senderEmail && !senderEmail) {
      throw new BadRequestException({ code: "INVALID_SENDER_EMAIL", message: "Enter a valid email address." });
    }
    const [existing] = senderDomain
      ? await this.db.select({ id: schema.senderRules.id }).from(schema.senderRules).where(and(eq(schema.senderRules.ownerUserId, userId), eq(schema.senderRules.senderDomain, senderDomain))).limit(1)
      : await this.db.select({ id: schema.senderRules.id }).from(schema.senderRules).where(and(eq(schema.senderRules.ownerUserId, userId), eq(schema.senderRules.senderEmail, senderEmail!))).limit(1);
    if (existing) {
      await this.db.update(schema.senderRules).set({ action: dto.action }).where(eq(schema.senderRules.id, existing.id));
      return { id: existing.id, senderDomain, senderEmail, action: dto.action };
    }
    const id = generateId("senderRule");
    await this.db.insert(schema.senderRules).values({ id, ownerUserId: userId, senderDomain, senderEmail, action: dto.action });
    return { id, senderDomain, senderEmail, action: dto.action };
  }

  async removeSenderRule(id: string, userId: string): Promise<void> {
    const [rule] = await this.db.select().from(schema.senderRules).where(eq(schema.senderRules.id, id)).limit(1);
    if (!rule) throw new NotFoundException({ code: "RULE_NOT_FOUND", message: "Sender rule not found." });
    if (rule.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your rule." });
    await this.db.delete(schema.senderRules).where(eq(schema.senderRules.id, id));
  }

  /**
   * MAIL-006 "From Inbox: Always treat messages from this sender as..." — the inline correction-flow action,
   * reachable right from a misclassified (or correctly classified but unwanted) item without visiting
   * Settings first, mirroring CAL-004's identical "Always trust reschedule emails like this one" action on
   * an offered reschedule. Resolves the item's own `sourceEvents.fromAddress` (rather than requiring the
   * caller to already know the sender) and scopes the new rule to that sender's DOMAIN, not the exact
   * address — "always treat mail from this sender" reads most naturally as "senders like this one" for a
   * one-click Inbox action; a narrower exact-address rule is still available via the standalone Settings
   * page (addSenderRule) for a user who wants that precision.
   */
  async addSenderRuleFromInboxItem(itemId: string, userId: string, action: SenderRuleAction): Promise<{ id: string; senderDomain: string | null; action: SenderRuleAction }> {
    const item = await this.assertOwned(itemId, userId);
    const [sourceEvent] = await this.db.select({ fromAddress: schema.sourceEvents.fromAddress }).from(schema.sourceEvents).where(eq(schema.sourceEvents.id, item.sourceEventId)).limit(1);
    const rawSender = sourceEvent?.fromAddress ? extractEmailAddress(sourceEvent.fromAddress) ?? sourceEvent.fromAddress : null;
    const senderDomain = rawSender ? normalizeSenderDomain(rawSender) : null;
    if (!senderDomain) {
      throw new BadRequestException({ code: "NO_SENDER", message: "Couldn't determine a sender domain for this item." });
    }
    return this.addSenderRule(userId, { senderDomain, action });
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
      case "pet_vaccination":
        result = await this.correctPetVaccination(item.linkedResourceId, dto);
        break;
      default:
        throw new BadRequestException({
          code: "UNSUPPORTED_RESOURCE_TYPE",
          message: `Corrections aren't supported for "${item.linkedResourceType}" yet.`,
        });
    }
    // §28.17 "audit application actions" gap — inbox corrections change a domain record's fields but
    // previously left no audit trail at all, unlike household ACL/ownership changes. Lower-stakes than
    // those (self-service, easily re-corrected, never touches access/permissions), but still a real
    // write to financial/schedule data worth a record of who changed what and when.
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
    await this.reindexPurchase(purchaseId);
  }

  /** §44.4 — re-derives the same title/body shape IngestionService.extractReceipt's own upsert uses, so a
   * user correction (or the original AI extraction) always leaves the exact same projection behind. */
  private async reindexPurchase(purchaseId: string): Promise<void> {
    if (!this.searchIndex) return;
    const [purchase] = await this.db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    if (!purchase) return;
    const merchantName = purchase.merchantId
      ? ((await this.db.select({ displayName: schema.merchants.displayName }).from(schema.merchants).where(eq(schema.merchants.id, purchase.merchantId)).limit(1))[0]?.displayName ?? "Unknown merchant")
      : "Unknown merchant";
    const lines = await this.db.select({ productLabel: schema.purchaseLines.productLabel }).from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
    await this.searchIndex.upsert({
      resourceType: "purchase",
      resourceId: purchaseId,
      ownerUserId: purchase.ownerUserId,
      householdId: purchase.householdId,
      sensitivity: "sensitive",
      title: `${merchantName}${purchase.orderNumber ? ` — order ${purchase.orderNumber}` : ""}`,
      bodyText: lines.map((l) => l.productLabel).join(", "),
      metadata: { orderNumber: purchase.orderNumber },
    });
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
    if (this.searchIndex) {
      const [bill] = await this.db.select().from(schema.bills).where(eq(schema.bills.id, billId)).limit(1);
      if (bill) {
        await this.searchIndex.upsert({
          resourceType: "bill",
          resourceId: billId,
          ownerUserId: bill.ownerUserId,
          householdId: bill.householdId,
          sensitivity: "sensitive",
          title: bill.billerLabel,
          bodyText: bill.billerCategory ?? "",
        });
      }
    }
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

    // CAL-001 write-back — a correction to a discovered event that's already been pushed to a connected
    // calendar (InboxService.addToCalendar) shouldn't silently drift out of sync with the provider's copy.
    // pushEvent re-reads the row this update just wrote, so it always sends the corrected fields; failures
    // are swallowed by pushEvent itself (see its doc comment), so a correction never fails just because the
    // provider push did.
    const [event] = await this.db
      .select({
        ownerUserId: schema.calendarEvents.ownerUserId,
        householdId: schema.calendarEvents.householdId,
        title: schema.calendarEvents.title,
        location: schema.calendarEvents.location,
        writeBackConnectionId: schema.calendarEvents.writeBackConnectionId,
      })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, eventId))
      .limit(1);
    if (event?.writeBackConnectionId) {
      await this.calendarWriteBack.pushEvent({ eventId, ownerUserId: event.ownerUserId, connectionId: event.writeBackConnectionId });
    }
    if (event) {
      await this.searchIndex?.upsert({
        resourceType: "calendar_event",
        resourceId: eventId,
        ownerUserId: event.ownerUserId,
        householdId: event.householdId,
        sensitivity: "sensitive",
        title: event.title,
        bodyText: event.location ?? "",
      });
    }
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
    if (this.searchIndex) {
      const [shipment] = await this.db.select().from(schema.shipments).where(eq(schema.shipments.id, shipmentId)).limit(1);
      if (shipment) {
        await this.searchIndex.upsert({
          resourceType: "shipment",
          resourceId: shipmentId,
          ownerUserId: shipment.ownerUserId,
          householdId: null,
          sensitivity: "standard",
          title: `${shipment.carrier} — ${shipment.trackingNumber}`,
          bodyText: shipment.status,
        });
      }
    }
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
    if (this.searchIndex) {
      const [warranty] = await this.db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId)).limit(1);
      if (warranty) {
        await this.searchIndex.upsert({
          resourceType: "warranty",
          resourceId: warrantyId,
          ownerUserId: warranty.ownerUserId,
          householdId: warranty.householdId,
          sensitivity: "standard",
          title: warranty.productLabel,
        });
      }
    }
  }

  /** PET-004 — reuses `title` (vaccine/license type) and `expirationDateIso` (already needed for warranty
   * corrections above) rather than adding pet-specific fields to CorrectInboxItemDtoSchema. */
  private async correctPetVaccination(vaccinationId: string, dto: CorrectInboxItemDto) {
    const patch: Partial<typeof schema.petVaccinations.$inferInsert> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.label = dto.title;
    if (dto.expirationDateIso !== undefined) {
      const temporal = dateTemporal(dto.expirationDateIso);
      patch.expirationDate = temporal;
      patch.expirationDateSort = temporalToSortDate(temporal);
    }
    await this.db.update(schema.petVaccinations).set(patch).where(eq(schema.petVaccinations.id, vaccinationId));
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

    if (this.searchIndex) {
      const [stream] = await this.db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.id, subscription.recurringStreamId)).limit(1);
      if (stream) {
        await this.searchIndex.upsert({
          resourceType: "subscription",
          resourceId: subscriptionId,
          ownerUserId: stream.ownerUserId,
          householdId: stream.householdId,
          sensitivity: "sensitive",
          title: stream.serviceLabel,
        });
      }
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

  /**
   * Phase 2 §52.2 "bulk management" — both `confirm` and `dismiss` are reversible, non-destructive review
   * actions (§AI-001 promotion / a soft "deleted" reviewState, not a hard row delete), so unlike a genuine
   * destructive batch (DSK-004's "high-risk/destructive batch has preview and count") this needs no extra
   * confirmation step beyond the bulk action itself — the per-item actions it wraps already carry that
   * safety property. One bad/unowned id in the batch is reported, not allowed to fail the rest.
   */
  async bulkAction(action: "confirm" | "dismiss", ids: string[], userId: string): Promise<{ succeeded: number; failed: string[] }> {
    let succeeded = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        if (action === "confirm") await this.confirm(id, userId);
        else await this.dismiss(id, userId);
        succeeded += 1;
      } catch {
        failed.push(id);
      }
    }
    return { succeeded, failed };
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
    // PET-004 "Deadline must be sourced/user-confirmed" — the real enforcement point: an
    // extractPetVaccination candidate is filed with `source: "evidence_sourced"` and must never be treated
    // as a confirmed deadline (see AttentionService.scanAndFileDeadlines's pet-vaccination scan, which only
    // ever reads confirmed rows) until the user actually confirms it here.
    if (item.linkedResourceType === "pet_vaccination" && item.linkedResourceId) {
      await this.db
        .update(schema.petVaccinations)
        .set({ confidenceBand, source: "user_confirmed", updatedAt: new Date() })
        .where(eq(schema.petVaccinations.id, item.linkedResourceId));
    }
    // Bill/calendar-event confidence is presentational (confidenceBand lives only on Fact/InboxItem for those
    // domains today); their own "verified" flag is added when the fact/versioning layer lands.
  }

  private async assertOwned(id: string, userId: string) {
    const [item] = await this.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "INBOX_ITEM_NOT_FOUND", message: "Not found." });
    // 403, not 400 — see attention.service.ts's identical fix for the full trace (this and its sibling
    // AttentionService check were the only two in this module family still using BadRequestException for
    // "exists but isn't yours", inconsistent with ScheduleService/DataExportService's ForbiddenException).
    if (item.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your item." });
    return item;
  }
}
