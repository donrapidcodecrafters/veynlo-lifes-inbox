import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { gmail_v1 } from "googleapis";
import { generateId, confidenceToBand } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";
import {
  DomainClassificationResultSchema,
  ReceiptExtractionSchema,
  BillExtractionSchema,
  CalendarEventExtractionSchema,
} from "../intelligence/extraction-schemas";
import { evaluateRelevance, matchKnownSender } from "../intelligence/deterministic-prefilter";
import { parseGmailMessage } from "./gmail-message-parser";
import { toTemporalValue, temporalToSortDate } from "./temporal.util";

interface IngestGmailParams {
  ownerUserId: string;
  householdId: string | null;
  connectionId: string;
  message: gmail_v1.Schema$Message;
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
  ) {}

  async ingestGmailMessage(params: IngestGmailParams): Promise<void> {
    const parsed = parseGmailMessage(params.message);
    const providerItemId = params.message.id ?? undefined;
    const contentHash = createHash("sha256").update(parsed.subject + parsed.bodyText).digest("hex");
    const idempotencyKey = `gmail:${providerItemId ?? contentHash}`;

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

  /** Entry point for share-capture/voice-note/manual-forward and for local testing without a live Gmail connection. */
  async ingestManualText(params: {
    ownerUserId: string;
    householdId: string | null;
    subject: string;
    bodyText: string;
    fromAddress?: string;
  }): Promise<{ sourceEventId: string }> {
    const contentHash = createHash("sha256").update(params.subject + params.bodyText).digest("hex");
    const idempotencyKey = `manual:${contentHash}`;
    const sourceEventId = generateId("sourceEvent");
    await this.db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      kind: "manual_entry",
      contentHash,
      occurredAt: new Date(),
      idempotencyKey,
      processingState: "understanding",
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
    const known = matchKnownSender(ctx.parsed.fromAddress);
    let domains: string[];

    if (known) {
      domains = [known.category];
    } else if (this.ai.isConfigured()) {
      const classification = await this.ai.extractStructured({
        extractorName: "domain_classifier_v1",
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
    if (domains.includes("receipt") || domains.includes("shipment")) {
      filedAny = (await this.extractReceipt(ctx, known?.merchantName ?? null)) || filedAny;
    }
    if (domains.includes("bill") || domains.includes("subscription")) {
      filedAny = (await this.extractBill(ctx)) || filedAny;
    }
    if (domains.includes("calendar_event") || domains.includes("travel")) {
      filedAny = (await this.extractCalendarEvent(ctx)) || filedAny;
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

    const purchaseId = generateId("purchase");
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
      await this.db.insert(schema.purchaseLines).values({
        id: generateId("purchaseLine"),
        purchaseId,
        productLabel: line.productLabel,
        quantity: line.quantity,
        unitPriceMinorUnits: line.unitPriceMinorUnits,
        lineTotalMinorUnits: line.unitPriceMinorUnits ? line.unitPriceMinorUnits * line.quantity : null,
        currency: result.data.currency,
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

    await this.db.insert(schema.inboxItems).values({
      id: generateId("inboxItem"),
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "purchase",
      summary: `${merchantName} — ${result.data.lineItems[0]?.productLabel ?? "purchase"} detected`,
      linkedResourceType: "purchase",
      linkedResourceId: purchaseId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "correct", "dismiss"],
      confidenceBand,
    });

    return true;
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
      dueDate,
      dueDateSort: temporalToSortDate(dueDate),
      autopayBelieved: result.data.autopayMentioned,
    });

    await this.db.insert(schema.inboxItems).values({
      id: generateId("inboxItem"),
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

  private async extractCalendarEvent(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
  }): Promise<boolean> {
    if (!this.ai.isConfigured()) return false;
    const result = await this.ai.extractStructured({
      extractorName: "calendar_event_extraction_v1",
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

    await this.db.insert(schema.inboxItems).values({
      id: generateId("inboxItem"),
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

  private async findOrCreateMerchant(displayName: string): Promise<string> {
    const [existing] = await this.db.select().from(schema.merchants).where(eq(schema.merchants.displayName, displayName)).limit(1);
    if (existing) return existing.id;
    const id = generateId("merchant");
    await this.db.insert(schema.merchants).values({ id, displayName });
    return id;
  }

  private async markProcessed(sourceEventId: string, state: string): Promise<void> {
    await this.db.update(schema.sourceEvents).set({ processingState: state }).where(eq(schema.sourceEvents.id, sourceEventId));
  }
}
