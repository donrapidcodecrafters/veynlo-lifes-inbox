import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";
import { generateId, confidenceToBand, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import {
  DomainClassificationResultSchema,
  ReceiptExtractionSchema,
  ShipmentExtractionSchema,
  BillExtractionSchema,
  CalendarEventExtractionSchema,
  WarrantyExtractionSchema,
  SubscriptionExtractionSchema,
} from "../intelligence/extraction-schemas";
import { evaluateRelevance, matchKnownSender } from "../intelligence/deterministic-prefilter";
import { parseGmailMessage, type ParsedEmail } from "./gmail-message-parser";
import { parseOutlookMessage, type GraphMessage } from "./outlook-message-parser";
import { toTemporalValue, temporalToSortDate } from "./temporal.util";

interface IngestGmailParams {
  ownerUserId: string;
  householdId: string | null;
  connectionId: string;
  message: gmail_v1.Schema$Message;
}

interface IngestOutlookParams {
  ownerUserId: string;
  householdId: string | null;
  connectionId: string;
  message: GraphMessage;
}

const RISK_THRESHOLDS = { reviewThreshold: 0.55, highThreshold: 0.85 };

/**
 * Orchestrates pipeline stages 0-5 for a single source event (§39.1):
 * prefilter → relevance → domain classification → structured extraction →
 * entity resolution (lightweight, merchant-by-domain for MVP) → persistence
 * + InboxItem creation. Stage 5 "rules/state logic" (deadlines, attention
 * scoring) is handled by the attention module once a candidate is filed.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ai: AnthropicExtractionService,
    private readonly notifications: NotificationDeliveryService,
  ) {}

  async ingestGmailMessage(params: IngestGmailParams): Promise<void> {
    await this.ingestParsedEmail({
      ...params,
      providerPrefix: "gmail",
      providerItemId: params.message.id ?? undefined,
      parsed: parseGmailMessage(params.message),
    });
  }

  async ingestOutlookMessage(params: IngestOutlookParams): Promise<void> {
    await this.ingestParsedEmail({
      ...params,
      providerPrefix: "outlook",
      providerItemId: params.message.id ?? undefined,
      parsed: parseOutlookMessage(params.message),
    });
  }

  private async ingestParsedEmail(params: {
    ownerUserId: string;
    householdId: string | null;
    connectionId: string;
    providerPrefix: string;
    providerItemId: string | undefined;
    parsed: ParsedEmail;
  }): Promise<void> {
    const { parsed, providerItemId } = params;
    const contentHash = createHash("sha256").update(parsed.subject + parsed.bodyText).digest("hex");
    const idempotencyKey = `${params.providerPrefix}:${providerItemId ?? contentHash}`;

    const [existing] = await this.db
      .select({ id: schema.sourceEvents.id })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existing) return; // idempotent re-sync — never reprocess the same email twice (§Duplicate prevention)

    const sourceEventId = generateId("sourceEvent");
    await this.db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      connectionId: params.connectionId,
      kind: "email_message",
      providerItemId: providerItemId ?? null,
      contentHash,
      occurredAt: parsed.dateHeader ? new Date(parsed.dateHeader) : new Date(),
      idempotencyKey,
      processingState: "understanding",
      subjectLine: parsed.subject || null,
      snippet: parsed.snippet || null,
      fromAddress: parsed.fromAddress || null,
    });

    const relevance = evaluateRelevance({
      subject: parsed.subject,
      fromAddress: parsed.fromAddress,
      snippet: parsed.snippet,
      headers: parsed.headers,
    });

    if (!relevance.relevant) {
      await this.markProcessed(sourceEventId, "filed"); // "filed" here means "correctly determined to need no further action"
      return;
    }

    await this.classifyAndExtract({ sourceEventId, ownerUserId: params.ownerUserId, householdId: params.householdId, parsed });
  }

  /** Entry point for share-capture/voice-note/manual-forward/URL-capture and for local testing without a live Gmail connection. */
  async ingestManualText(params: {
    ownerUserId: string;
    householdId: string | null;
    subject: string;
    bodyText: string;
    fromAddress?: string;
    /** Distinguishes the source in source_events.kind / the evidence view — e.g. "url_capture" reuses this
     * same method (URL capture already IS a subject+bodyText pair once fetched and text-extracted) rather
     * than duplicating it, passing the source URL as fromAddress. */
    kind?: string;
  }): Promise<{ sourceEventId: string }> {
    const kind = params.kind ?? "manual_entry";
    const contentHash = createHash("sha256").update(params.subject + params.bodyText).digest("hex");
    const idempotencyKey = `${kind}:${contentHash}`;
    const sourceEventId = generateId("sourceEvent");
    await this.db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      kind,
      contentHash,
      occurredAt: new Date(),
      idempotencyKey,
      processingState: "understanding",
      subjectLine: params.subject || null,
      snippet: params.bodyText.slice(0, 200) || null,
      fromAddress: params.fromAddress || null,
    });
    await this.classifyAndExtract({
      sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      parsed: {
        subject: params.subject,
        fromAddress: params.fromAddress ?? "",
        toAddress: "",
        dateHeader: "",
        snippet: params.bodyText.slice(0, 200),
        bodyText: params.bodyText,
        headers: {},
      },
    });
    return { sourceEventId };
  }

  private async classifyAndExtract(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
  }): Promise<void> {
    const known = matchKnownSender(ctx.parsed.fromAddress, `${ctx.parsed.subject}\n${ctx.parsed.snippet}`);
    let domains: string[];

    if (known) {
      domains = [known.category];
    } else if (this.ai.isConfigured()) {
      const classification = await this.ai.extractStructured({
        extractorName: "domain_classifier_v1",
        sourceEventId: ctx.sourceEventId,
        model: "cheap",
        systemPrompt:
          "You classify emails into life-management domains for Veynlo, a personal life operating system. " +
          "Only select domains with clear textual evidence. If nothing is actionable, return only 'irrelevant'.",
        userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 6000)}`,
        schema: DomainClassificationResultSchema,
        toolDescription: "Classify this message's Veynlo domains.",
      });
      domains = classification?.data.domains ?? ["irrelevant"];
    } else {
      domains = ["irrelevant"];
    }

    if (domains.includes("irrelevant") && domains.length === 1) {
      await this.markProcessed(ctx.sourceEventId, "filed");
      return;
    }

    let filedAny = false;
    if (domains.includes("receipt")) {
      filedAny = (await this.extractReceipt(ctx, known?.category === "receipt" ? known.merchantName : null)) || filedAny;
    }
    if (domains.includes("shipment")) {
      filedAny = (await this.extractShipment(ctx, known?.category === "shipment" ? known.merchantName : null)) || filedAny;
    }
    if (domains.includes("bill")) {
      filedAny = (await this.extractBill(ctx)) || filedAny;
    }
    if (domains.includes("subscription")) {
      filedAny = (await this.extractSubscription(ctx)) || filedAny;
    }
    if (domains.includes("calendar_event") || domains.includes("travel")) {
      filedAny = (await this.extractCalendarEvent(ctx)) || filedAny;
    }
    if (domains.includes("warranty")) {
      filedAny = (await this.extractWarranty(ctx)) || filedAny;
    }

    await this.markProcessed(ctx.sourceEventId, filedAny ? "needs_review" : "filed");
  }

  private async extractReceipt(
    ctx: { sourceEventId: string; ownerUserId: string; householdId: string | null; parsed: ReturnType<typeof parseGmailMessage> },
    knownMerchantName: string | null,
  ): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "receipt_extraction_v1",
      sourceEventId: ctx.sourceEventId,
      model: "cheap",
      systemPrompt:
        "Extract structured purchase/receipt data from this email for Veynlo. Never invent a date or amount that " +
        "is not clearly stated — use null and confidenceNotes instead.",
      userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 8000)}`,
      schema: ReceiptExtractionSchema,
      toolDescription: "Emit the extracted receipt/purchase fields.",
    });
    if (!result) return false;

    const merchantName = knownMerchantName ?? result.data.merchantName ?? "Unknown merchant";
    const merchantId = await this.findOrCreateMerchant(merchantName);
    const confidenceBand = confidenceToBand(result.confidenceScore, RISK_THRESHOLDS);
    const purchaseDate = toTemporalValue(result.data.purchaseDate);

    // §40.1 "Auto-merge exact order IDs" — a second email about the same order (payment confirmation
    // following an order confirmation, a receipt duplicating a prior notice) must update the existing
    // purchase rather than create a sibling. Only order-number+merchant is exact enough to auto-merge.
    // When no order number is stated at all (common on a plain confirmation email), fall back to a
    // conservative same-merchant/same-total/close-date match rather than always creating a duplicate —
    // see findExistingPurchaseByAmountAndDate for exactly how conservative ("more than one candidate ->
    // treat as no match" per §40.2's precision-first stance).
    const existing = result.data.orderNumber
      ? await this.findExistingPurchase(ctx.ownerUserId, merchantId, result.data.orderNumber)
      : await this.findExistingPurchaseByAmountAndDate(ctx.ownerUserId, merchantId, result.data.totalAmountMinorUnits, temporalToSortDate(purchaseDate));

    const purchaseId = existing?.id ?? generateId("purchase");
    if (existing) {
      await this.db
        .update(schema.purchases)
        .set({
          // Fill in gaps rather than clobber previously-confirmed values with a lower-quality later extraction.
          totalMinorUnits: existing.totalMinorUnits ?? result.data.totalAmountMinorUnits,
          taxMinorUnits: existing.taxMinorUnits ?? result.data.taxMinorUnits,
          shippingMinorUnits: existing.shippingMinorUnits ?? result.data.shippingMinorUnits,
          updatedAt: new Date(),
        })
        .where(eq(schema.purchases.id, purchaseId));
    } else {
      await this.db.insert(schema.purchases).values({
        id: purchaseId,
        ownerUserId: ctx.ownerUserId,
        householdId: ctx.householdId,
        merchantId,
        orderNumber: result.data.orderNumber,
        purchaseDate,
        purchaseDateSort: temporalToSortDate(purchaseDate),
        totalMinorUnits: result.data.totalAmountMinorUnits,
        totalCurrency: result.data.currency,
        taxMinorUnits: result.data.taxMinorUnits,
        shippingMinorUnits: result.data.shippingMinorUnits,
        state: "candidate",
        confidenceBand,
        sourceEventId: ctx.sourceEventId,
      });

      for (const line of result.data.lineItems) {
        // §39.3/§44.1 knowledge-graph write path — one owner-scoped canonical_entities row per physical
        // product line, so a later extractor (e.g. extractWarranty) can identify "the same thing" across
        // separate emails via purchaseLines.ownerAssetEntityId rather than two unlinked records. Always
        // creates rather than matches an existing entity (§40.2 "false non-merge is preferable to
        // incorrectly combining" — precision-first; there's no reliable signal yet, like a serial number,
        // to safely dedupe two purchase lines against each other).
        const assetEntityId = generateId("entity");
        await this.db.insert(schema.canonicalEntities).values({
          id: assetEntityId,
          type: "asset",
          ownerUserId: ctx.ownerUserId,
          householdId: ctx.householdId,
          displayLabel: line.productLabel,
          aliases: [], // encryptedJsonb columns don't get a working DB-level default — see documents.tags' history
          lifecycleState: "active",
        });
        await this.db.insert(schema.purchaseLines).values({
          id: generateId("purchaseLine"),
          purchaseId,
          productLabel: line.productLabel,
          quantity: line.quantity,
          unitPriceMinorUnits: line.unitPriceMinorUnits,
          lineTotalMinorUnits: line.unitPriceMinorUnits ? line.unitPriceMinorUnits * line.quantity : null,
          currency: result.data.currency,
          ownerAssetEntityId: assetEntityId,
        });
      }

      if (result.data.returnDeadline) {
        const deadline = toTemporalValue(result.data.returnDeadline);
        await this.db.insert(schema.returnCases).values({
          id: generateId("returnCase"),
          purchaseId,
          state: "eligible",
          deadline,
          deadlineSort: temporalToSortDate(deadline),
          valueAtStakeMinorUnits: result.data.totalAmountMinorUnits,
          valueAtStakeCurrency: result.data.currency,
        });
      }
    }

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "purchase",
      summary: existing
        ? `${merchantName} order updated — ${result.data.orderNumber}`
        : `${merchantName} — ${result.data.lineItems[0]?.productLabel ?? "purchase"} detected`,
      linkedResourceType: "purchase",
      linkedResourceId: purchaseId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: existing ? ["confirm", "dismiss"] : ["confirm", "correct", "dismiss"],
      confidenceBand,
    });

    return true;
  }

  private async extractShipment(
    ctx: { sourceEventId: string; ownerUserId: string; householdId: string | null; parsed: ReturnType<typeof parseGmailMessage> },
    knownCarrierName: string | null,
  ): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "shipment_extraction_v1",
      sourceEventId: ctx.sourceEventId,
      model: "cheap",
      systemPrompt:
        "Extract structured shipping/tracking data from this email for Veynlo. Never invent a carrier, tracking " +
        "number, or delivery date that is not clearly stated.",
      userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 8000)}`,
      schema: ShipmentExtractionSchema,
      toolDescription: "Emit the extracted shipment fields.",
    });
    if (!result || !result.data.trackingNumber) return false;

    const carrier = knownCarrierName ?? result.data.carrier ?? "Unknown carrier";
    const confidenceBand = confidenceToBand(result.confidenceScore, RISK_THRESHOLDS);
    const estimatedDelivery = toTemporalValue(result.data.estimatedDelivery);

    // Best-effort link to the purchase this shipment belongs to — a carrier email rarely restates the
    // merchant the way a receipt does, so this matches on order number alone when the merchant can't be
    // resolved (§40.1: shipment auto-merge is by carrier+tracking; linking to a purchase is a weaker,
    // order-number-only match and stays unlinked rather than guessing when no order number is present).
    const linkedPurchase = result.data.orderNumber
      ? await this.findExistingPurchaseByOrderNumberOnly(ctx.ownerUserId, result.data.orderNumber)
      : null;

    const existingShipment = await this.findExistingShipment(result.data.trackingNumber);
    const shipmentId = existingShipment?.id ?? generateId("shipment");
    if (existingShipment) {
      await this.db
        .update(schema.shipments)
        .set({
          status: result.data.status ?? existingShipment.status,
          estimatedDelivery,
          updatedAt: new Date(),
        })
        .where(eq(schema.shipments.id, shipmentId));
    } else {
      await this.db.insert(schema.shipments).values({
        id: shipmentId,
        purchaseId: linkedPurchase?.id ?? null,
        carrier,
        trackingNumber: result.data.trackingNumber,
        status: result.data.status ?? "in_transit",
        confidenceBand,
        estimatedDelivery,
        isGiftPrivate: false,
      });
    }

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "shipment",
      summary: existingShipment
        ? `${carrier} tracking ${result.data.trackingNumber} updated — ${result.data.status ?? "in transit"}`
        : `${carrier} package ${result.data.status === "delivered" ? "delivered" : "on its way"}`,
      linkedResourceType: "shipment",
      linkedResourceId: shipmentId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "dismiss"],
      confidenceBand,
    });

    return true;
  }

  private async findExistingPurchase(ownerUserId: string, merchantId: string, orderNumber: string) {
    const [existing] = await this.db
      .select()
      .from(schema.purchases)
      .where(
        and(
          eq(schema.purchases.ownerUserId, ownerUserId),
          eq(schema.purchases.merchantId, merchantId),
          eq(schema.purchases.orderNumber, orderNumber),
        ),
      )
      .limit(1);
    return existing ?? null;
  }

  /**
   * Fallback dedup for when the extracted email has no order number at all (so findExistingPurchase's
   * exact-match path never runs). Requires same merchant + identical total + purchase date within 2 days
   * of an existing purchase's — and if more than one existing purchase matches that, treats it as no
   * match rather than guessing which one, since an ambiguous auto-merge risks combining two genuinely
   * different purchases (§40.2 "false non-merge is preferable to incorrectly combining").
   */
  private async findExistingPurchaseByAmountAndDate(ownerUserId: string, merchantId: string, totalMinorUnits: number | null, purchaseDateSort: Date | null) {
    if (totalMinorUnits == null || !purchaseDateSort) return null;
    const windowStart = new Date(purchaseDateSort.getTime() - 2 * 86_400_000);
    const windowEnd = new Date(purchaseDateSort.getTime() + 2 * 86_400_000);
    const candidates = await this.db
      .select()
      .from(schema.purchases)
      .where(
        and(
          eq(schema.purchases.ownerUserId, ownerUserId),
          eq(schema.purchases.merchantId, merchantId),
          eq(schema.purchases.totalMinorUnits, totalMinorUnits),
          gte(schema.purchases.purchaseDateSort, windowStart),
          lte(schema.purchases.purchaseDateSort, windowEnd),
        ),
      )
      .limit(2);
    return candidates.length === 1 ? candidates[0] : null;
  }

  private async findExistingPurchaseByOrderNumberOnly(ownerUserId: string, orderNumber: string) {
    const [existing] = await this.db
      .select({ id: schema.purchases.id })
      .from(schema.purchases)
      .where(and(eq(schema.purchases.ownerUserId, ownerUserId), eq(schema.purchases.orderNumber, orderNumber)))
      .limit(1);
    return existing ?? null;
  }

  private async findExistingShipment(trackingNumber: string) {
    const [existing] = await this.db.select().from(schema.shipments).where(eq(schema.shipments.trackingNumber, trackingNumber)).limit(1);
    return existing ?? null;
  }

  /** Used by extractWarranty — see its call site for why this deliberately requires an exact match. */
  private async findMatchingPurchaseLine(ownerUserId: string, productLabel: string) {
    const candidates = await this.db
      .select({ line: schema.purchaseLines })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    const normalized = productLabel.trim().toLowerCase();
    return candidates.find((c) => c.line.productLabel.trim().toLowerCase() === normalized)?.line ?? null;
  }

  private async extractBill(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
  }): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "bill_extraction_v1",
      sourceEventId: ctx.sourceEventId,
      model: "cheap",
      systemPrompt:
        "Extract structured bill/subscription data from this email for Veynlo. Never invent a due date or amount " +
        "that is not clearly stated — use null and confidenceNotes instead.",
      userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 8000)}`,
      schema: BillExtractionSchema,
      toolDescription: "Emit the extracted bill fields.",
    });
    if (!result || !result.data.billerName) return false;

    const confidenceBand = confidenceToBand(result.confidenceScore, RISK_THRESHOLDS);
    const dueDate = toTemporalValue(result.data.dueDate);
    const billId = generateId("bill");
    await this.db.insert(schema.bills).values({
      id: billId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      billerLabel: result.data.billerName,
      amountDueMinorUnits: result.data.amountDueMinorUnits,
      amountDueCurrency: result.data.currency,
      confidenceBand,
      dueDate,
      dueDateSort: temporalToSortDate(dueDate),
      autopayBelieved: result.data.autopayMentioned,
    });

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "bill",
      summary: `${result.data.billerName} bill detected`,
      linkedResourceType: "bill",
      linkedResourceId: billId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "correct", "dismiss"],
      confidenceBand,
    });
    return true;
  }

  private async extractSubscription(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
  }): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "subscription_extraction_v1",
      sourceEventId: ctx.sourceEventId,
      model: "cheap",
      systemPrompt:
        "Extract structured recurring-subscription data from this email for Veynlo (trial started, renewal " +
        "confirmed, price changed, etc). Never invent a billing date or amount that is not clearly stated — " +
        "use null and confidenceNotes instead.",
      userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 8000)}`,
      schema: SubscriptionExtractionSchema,
      toolDescription: "Emit the extracted subscription fields.",
    });
    if (!result || !result.data.serviceLabel) return false;

    const confidenceBand = confidenceToBand(result.confidenceScore, RISK_THRESHOLDS);
    // Unlike extractReceipt's merchant resolution, this is best-effort only — a subscription email doesn't
    // always name the billing merchant separately from the service itself (e.g. "Netflix" is both).
    const merchantId = result.data.merchantName ? await this.findOrCreateMerchant(result.data.merchantName) : null;
    const nextExpectedDate = toTemporalValue(result.data.nextBillingDate);
    const trialEndsAt = toTemporalValue(result.data.trialEndsDate);

    // No dedup against an existing recurring stream — same precedent as extractBill just above, which also
    // creates a fresh row per extraction rather than matching an existing one. (serviceLabel is encrypted
    // too, so it couldn't be looked up by equality anyway — see every other encrypted-column comment.)
    const recurringStreamId = generateId("recurringStream");
    await this.db.insert(schema.recurringStreams).values({
      id: recurringStreamId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      merchantId,
      serviceLabel: result.data.serviceLabel,
      cadence: result.data.cadence ?? "irregular",
      typicalAmountMinorUnits: result.data.amountMinorUnits,
      typicalAmountCurrency: result.data.currency,
      nextExpectedDate,
    });

    const subscriptionId = generateId("subscription");
    await this.db.insert(schema.subscriptions).values({
      id: subscriptionId,
      recurringStreamId,
      state: result.data.isTrial ? "trial" : "candidate",
      confidenceBand,
      trialEndsAt,
      cancellationInstructionsUrl: result.data.cancellationInstructionsUrl,
    });

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "subscription",
      summary: `${result.data.serviceLabel} subscription detected`,
      linkedResourceType: "subscription",
      linkedResourceId: subscriptionId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "correct", "dismiss"],
      confidenceBand,
    });
    return true;
  }

  private async extractCalendarEvent(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
  }): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "calendar_event_extraction_v1",
      sourceEventId: ctx.sourceEventId,
      model: "cheap",
      systemPrompt:
        "Extract a structured calendar event (appointment/reservation/travel milestone) from this email for " +
        "Veynlo. Never invent a date/time that is not clearly stated.",
      userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 8000)}`,
      schema: CalendarEventExtractionSchema,
      toolDescription: "Emit the extracted calendar event fields.",
    });
    if (!result) return false;

    const confidenceBand = confidenceToBand(result.confidenceScore, RISK_THRESHOLDS);
    const start = toTemporalValue(result.data.startDate, result.data.timezone);
    const eventId = generateId("calendarEvent");
    await this.db.insert(schema.calendarEvents).values({
      id: eventId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      title: result.data.title,
      start,
      startSort: temporalToSortDate(start),
      isAllDay: result.data.isAllDay,
      location: result.data.location,
      source: "discovered_from_evidence",
      status: "confirmed",
      visibility: "private",
    });

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "appointment",
      summary: `${result.data.title} discovered`,
      linkedResourceType: "calendar_event",
      linkedResourceId: eventId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "add_to_calendar", "dismiss"],
      confidenceBand,
    });
    return true;
  }

  private async extractWarranty(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
  }): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "warranty_extraction_v1",
      sourceEventId: ctx.sourceEventId,
      model: "cheap",
      systemPrompt:
        "Extract structured product warranty data from this email for Veynlo. Never invent an expiration date " +
        "or warranty length that is not clearly stated — use null and confidenceNotes instead.",
      userContent: `Subject: ${ctx.parsed.subject}\n\nBody:\n${ctx.parsed.bodyText.slice(0, 8000)}`,
      schema: WarrantyExtractionSchema,
      toolDescription: "Emit the extracted warranty fields.",
    });
    if (!result || !result.data.productLabel) return false;

    const confidenceBand = confidenceToBand(result.confidenceScore, RISK_THRESHOLDS);
    const expirationDate = toTemporalValue(result.data.warrantyExpirationDate);
    const warrantyId = generateId("warranty");
    // §40.1 entity resolution, applied to the one real cross-extractor case this app has today: a
    // warranty registration email and the receipt for the same product arrive separately, but should
    // resolve to the same canonical_entities asset row (created by extractReceipt). Deliberately
    // conservative — exact case-insensitive productLabel match only, no fuzzy/similarity scoring, no
    // auto-created entity when nothing matches — same precision-first stance as extractReceipt's own
    // comment. An unmatched warranty just leaves purchaseLineId null, exactly like today's behavior.
    const matchedLine = await this.findMatchingPurchaseLine(ctx.ownerUserId, result.data.productLabel);
    await this.db.insert(schema.warranties).values({
      id: warrantyId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      purchaseLineId: matchedLine?.id ?? null,
      productLabel: result.data.productLabel,
      warrantyLengthMonths: result.data.warrantyLengthMonths,
      confidenceBand,
      expirationDate,
      expirationDateSort: temporalToSortDate(expirationDate),
      registrationConfirmed: result.data.registrationConfirmed,
    });

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "warranty",
      summary: `${result.data.productLabel} warranty detected`,
      linkedResourceType: "warranty",
      linkedResourceId: warrantyId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "correct", "dismiss"],
      confidenceBand,
    });
    return true;
  }

  /**
   * Shared sync entry point for every "the source already IS a calendar event" connector — ICS feeds and
   * the Google Calendar API adapter alike — structurally different from every other ingest*Message method:
   * there's no relevance prefilter, no AI domain classification, no structured extraction. Deterministic
   * sync, not an AI inference, so the resulting inbox item only ever offers "dismiss" (there's nothing to
   * "confirm" — the event is already live).
   *
   * Idempotency is content-hash-based rather than the plain per-item dedup every other ingest*Message
   * method uses, because a feed resync must be a no-op for an UNCHANGED event but must actually update an
   * event whose time/title/location changed since the last sync — the source_events idempotencyKey
   * encodes the content hash precisely so "same UID, same content" short-circuits while "same UID,
   * different content" is treated as a fresh event to file. The calendar_events row itself is looked up
   * and updated in place by (ownerUserId, providerEventId) rather than ever inserting a duplicate.
   */
  async ingestFeedCalendarEvent(params: {
    provider: string;
    ownerUserId: string;
    householdId: string | null;
    /** Null for a source with no `connections` row at all — e.g. a device's local calendar pushed
     * directly from the mobile app, which has no OAuth connection or feed URL to represent as one. */
    connectionId: string | null;
    uid: string;
    title: string;
    start: TemporalValue;
    end: TemporalValue | null;
    isAllDay: boolean;
    location: string | null;
  }): Promise<boolean> {
    const contentHash = createHash("sha256")
      .update(JSON.stringify({ title: params.title, start: params.start, end: params.end, location: params.location, isAllDay: params.isAllDay }))
      .digest("hex");
    // Falls back to ownerUserId when there's no connection row to scope by (a device's local calendar) —
    // still unique per user+provider+event, which is all this key needs to guarantee.
    const idempotencyKey = `${params.provider}:${params.connectionId ?? params.ownerUserId}:${params.uid}:${contentHash}`;

    const [existingSourceEvent] = await this.db
      .select({ id: schema.sourceEvents.id })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existingSourceEvent) return false; // unchanged since the last sync — nothing to do

    const sourceEventId = generateId("sourceEvent");
    await this.db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      connectionId: params.connectionId,
      kind: "calendar_feed_event",
      contentHash,
      occurredAt: new Date(),
      idempotencyKey,
      processingState: "needs_review",
      subjectLine: params.title || null,
      snippet: params.location || null,
    });

    const [existingEvent] = await this.db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.ownerUserId, params.ownerUserId), eq(schema.calendarEvents.providerEventId, params.uid)))
      .limit(1);

    const eventId = existingEvent?.id ?? generateId("calendarEvent");
    const startSort = temporalToSortDate(params.start);
    if (existingEvent) {
      await this.db
        .update(schema.calendarEvents)
        .set({
          title: params.title,
          start: params.start,
          startSort,
          end: params.end,
          isAllDay: params.isAllDay,
          location: params.location,
          updatedAt: new Date(),
        })
        .where(eq(schema.calendarEvents.id, eventId));
    } else {
      await this.db.insert(schema.calendarEvents).values({
        id: eventId,
        ownerUserId: params.ownerUserId,
        householdId: params.householdId,
        title: params.title,
        start: params.start,
        startSort,
        end: params.end,
        isAllDay: params.isAllDay,
        location: params.location,
        source: "discovered_from_evidence",
        providerEventId: params.uid,
        status: "confirmed",
        visibility: "private",
      });
    }

    await this.fileInboxItem({
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      category: "appointment",
      summary: existingEvent ? `${params.title} updated on your synced calendar` : `${params.title} added from your synced calendar`,
      linkedResourceType: "calendar_event",
      linkedResourceId: eventId,
      sourceEventId,
      suggestedActions: ["dismiss"],
      confidenceBand: "verified",
    });

    return true;
  }

  /**
   * Creates the Inbox review card and, only for high/verified confidence,
   * a "useful"-priority notification — low/needs-review candidates stay in
   * the Inbox silently rather than pinging the user about something Veynlo
   * itself isn't sure about (§AI-002 risk policy driving notification tier,
   * not just canonical-data acceptance).
   */
  private async fileInboxItem(params: {
    ownerUserId: string;
    householdId: string | null;
    category: string;
    summary: string;
    linkedResourceType: string;
    linkedResourceId: string;
    sourceEventId: string;
    suggestedActions: string[];
    confidenceBand: string;
  }): Promise<void> {
    const inboxItemId = generateId("inboxItem");
    await this.db.insert(schema.inboxItems).values({
      id: inboxItemId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      category: params.category,
      summary: params.summary,
      linkedResourceType: params.linkedResourceType,
      linkedResourceId: params.linkedResourceId,
      sourceEventId: params.sourceEventId,
      suggestedActions: params.suggestedActions,
      confidenceBand: params.confidenceBand,
    });

    if (params.confidenceBand === "high" || params.confidenceBand === "verified") {
      await this.notifications.createAndEnqueue({
        ownerUserId: params.ownerUserId,
        dedupeKey: `inbox-item:${inboxItemId}`,
        priority: "useful",
        title: "Veynlo found something new",
        body: params.summary,
      });
    }
  }

  private async findOrCreateMerchant(displayName: string): Promise<string> {
    const [existing] = await this.db.select().from(schema.merchants).where(eq(schema.merchants.displayName, displayName)).limit(1);
    if (existing) {
      // An admin may have merged this exact merchant row into another one (see AdminService.mergeMerchants) —
      // new purchases should attach to the surviving merchant, not resurrect the merged-away one.
      return existing.mergedIntoMerchantId ?? existing.id;
    }
    const id = generateId("merchant");
    await this.db.insert(schema.merchants).values({ id, displayName });
    return id;
  }

  private async markProcessed(sourceEventId: string, state: string): Promise<void> {
    await this.db.update(schema.sourceEvents).set({ processingState: state }).where(eq(schema.sourceEvents.id, sourceEventId));
  }
}
