import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, lte, ne } from "drizzle-orm";
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
import { evaluateRelevance, matchKnownSender, extractEmailAddress } from "../intelligence/deterministic-prefilter";
import { parseGmailMessage, type ParsedEmail } from "./gmail-message-parser";
import { parseOutlookMessage, type GraphMessage } from "./outlook-message-parser";
import { toTemporalValue, temporalToSortDate } from "./temporal.util";
import { DocumentsService } from "../documents/documents.service";
import { SearchIndexService } from "../search/search-index.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { normalizeMerchantName } from "../admin/admin.service";

interface EmailAttachment {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

interface IngestGmailParams {
  ownerUserId: string;
  householdId: string | null;
  connectionId: string;
  message: gmail_v1.Schema$Message;
  attachments?: EmailAttachment[];
}

interface IngestOutlookParams {
  ownerUserId: string;
  householdId: string | null;
  connectionId: string;
  message: GraphMessage;
  attachments?: EmailAttachment[];
}

/** MAIL-004 "attachment intelligence" — the OCR-capable subset of DocumentsService's own ALLOWED_MIME_TYPES (excludes text/plain: a .txt attachment has no OCR step to run and isn't the "PDF/image attachment as evidence" the spec means). */
const DOCUMENT_ATTACHMENT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic"]);

/** §54.2 launch criteria #4 "conflicts are surfaced" — a materially different amount for what was matched
 * as the same real-world record (a corrected invoice total, two different bills that happened to match
 * the same biller/date window) previously either silently overwrote the old value or silently kept it,
 * with no signal to the user either way. Exact equality, not a tolerance band — a currency-conversion or
 * rounding-noise false positive is far less costly than a real amount discrepancy going unflagged. */
export function amountsConflict(existingMinorUnits: number | null, incomingMinorUnits: number | null): boolean {
  return existingMinorUnits != null && incomingMinorUnits != null && existingMinorUnits !== incomingMinorUnits;
}

/** Same idea for dates — a >1-day gap, not same-instant, so timezone/precision noise between two
 * extractions of the same underlying date doesn't read as a real conflict. */
export function datesConflict(existingSort: Date | null, incomingSort: Date | null): boolean {
  if (!existingSort || !incomingSort) return false;
  return Math.abs(existingSort.getTime() - incomingSort.getTime()) > 24 * 60 * 60 * 1000;
}

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
    private readonly documents: DocumentsService,
    private readonly searchIndex: SearchIndexService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly riskPolicy: RiskPolicyService,
  ) {}

  async ingestGmailMessage(params: IngestGmailParams): Promise<void> {
    await this.ingestParsedEmail({
      ...params,
      providerPrefix: "gmail",
      providerItemId: params.message.id ?? undefined,
      parsed: parseGmailMessage(params.message),
      rawContentRef: params.message.id ? `https://mail.google.com/mail/u/0/#all/${params.message.id}` : null,
    });
  }

  async ingestOutlookMessage(params: IngestOutlookParams): Promise<void> {
    await this.ingestParsedEmail({
      ...params,
      providerPrefix: "outlook",
      providerItemId: params.message.id ?? undefined,
      parsed: parseOutlookMessage(params.message),
      rawContentRef: params.message.webLink ?? null,
    });
  }

  private async ingestParsedEmail(params: {
    ownerUserId: string;
    householdId: string | null;
    connectionId: string;
    providerPrefix: string;
    providerItemId: string | undefined;
    parsed: ParsedEmail;
    rawContentRef: string | null;
    attachments?: EmailAttachment[];
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
      rawContentRef: params.rawContentRef,
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

    await this.classifyAndExtract({
      sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      parsed,
      attachments: params.attachments,
    });
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

    // A real bug found via a genuine double-submit test (a double-tap, a retried request after a slow/
    // dropped response — this endpoint has no other duplicate guard the way most connector-sync paths do):
    // idempotencyKey was always computed and stored, but never actually CHECKED before inserting, so the
    // second identical submission hit source_events_idempotency_idx's unique constraint and surfaced as a
    // raw 500, even though the content genuinely was already captured successfully the first time. Now
    // returns the existing row instead of re-inserting or re-running extraction a second time.
    const [existing] = await this.db
      .select({ id: schema.sourceEvents.id })
      .from(schema.sourceEvents)
      .where(and(eq(schema.sourceEvents.ownerUserId, params.ownerUserId), eq(schema.sourceEvents.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return { sourceEventId: existing.id };

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

  /**
   * §Connections "generic import fallback" — a real gap found by re-checking against the spec directly
   * rather than this project's own tracking doc: the "forwarding" half (`inboundEmailAlias`) was built,
   * but nothing let a user bring in a BATCH of items from outside Veynlo at once (an exported reminders
   * list, notes copied from another app, etc.) — only one-at-a-time manual/URL capture existed.
   *
   * Deliberately plain-text, blank-line-delimited rather than real CSV: hand-rolling correct CSV quoting
   * (embedded commas/newlines/escaped quotes) has real, easy-to-get-wrong edge cases, and a blank-line-
   * delimited block format covers the actual use case (pasting/forwarding a batch of items) without that
   * risk. Each block's first line becomes the subject, the rest becomes the body — the same "first line as
   * subject" convention the Capture forms already use for a single manual/voice item. Capped at 200 items
   * per import (§54.1 "AI cost" risk — this is a genuine batch AI-extraction trigger, not a free-form
   * amount a user could otherwise unintentionally multiply). Each item reuses `ingestManualText` as-is, so
   * it gets the exact same idempotency-key dedup, classification, and extraction path as any other capture
   * — nothing about the pipeline itself needed to know this came from a bulk import.
   */
  async bulkImport(params: { ownerUserId: string; householdId: string | null; text: string }): Promise<{ importedCount: number; skippedCount: number }> {
    const blocks = params.text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean)
      .slice(0, 200);

    let importedCount = 0;
    let skippedCount = 0;
    for (const block of blocks) {
      const lines = block.split("\n");
      const subject = lines[0]?.slice(0, 500);
      const bodyText = lines.slice(1).join("\n").trim() || lines[0] || "";
      if (!subject) {
        skippedCount += 1;
        continue;
      }
      await this.ingestManualText({ ownerUserId: params.ownerUserId, householdId: params.householdId, subject, bodyText, kind: "bulk_import" });
      importedCount += 1;
    }
    return { importedCount, skippedCount };
  }

  private async classifyAndExtract(ctx: {
    sourceEventId: string;
    ownerUserId: string;
    householdId: string | null;
    parsed: ReturnType<typeof parseGmailMessage>;
    attachments?: EmailAttachment[];
  }): Promise<void> {
    // MAIL-006 "user sender rules" — checked first, before even the AI-processing opt-out: a blocked
    // sender should never surface at all, opt-out or not.
    const senderRule = await this.findSenderRule(ctx.ownerUserId, ctx.parsed.fromAddress);
    if (senderRule?.action === "block") {
      await this.markProcessed(ctx.sourceEventId, "filed");
      return;
    }

    // PRIV-001 privacy/consent center's "AI processing" opt-out — checked here, before ANY AI call, not
    // just the domain-classifier one below: a known-sender match still routes into extractReceipt/
    // extractBill/etc., which themselves call the AI extractor for field-level extraction, so gating only
    // the classifier wouldn't actually stop AI processing for a user who opted out.
    const [user] = await this.db
      .select({ aiProcessingEnabled: schema.users.aiProcessingEnabled, disabledMailCategories: schema.users.disabledMailCategories })
      .from(schema.users)
      .where(eq(schema.users.id, ctx.ownerUserId))
      .limit(1);
    if (user && !user.aiProcessingEnabled) {
      await this.markProcessed(ctx.sourceEventId, "filed");
      return;
    }

    // §Operations "feature flags" / AI cost risk (§54.1) — a real global kill switch for the single most
    // expensive, most incident-prone code path in the pipeline. Every domain's extractX method requires a
    // real AI call for field-level extraction regardless of how the domain was classified (there is no
    // fully-deterministic extraction path today — see each extractX's own `this.ai.isConfigured()` guard),
    // so this has to short-circuit the whole event exactly like the per-user opt-out above rather than
    // just skip the classifier call — gating only the classifier would still let a known-sender/rule match
    // fall through into a real (still-billed) extraction call.
    if (await this.featureFlags.isEnabled("ai_extraction_disabled")) {
      await this.markProcessed(ctx.sourceEventId, "filed");
      return;
    }

    const known = matchKnownSender(ctx.parsed.fromAddress, `${ctx.parsed.subject}\n${ctx.parsed.snippet}`);
    let domains: string[];

    if (senderRule?.action === "category_override" && senderRule.categoryOverride) {
      domains = [senderRule.categoryOverride];
    } else if (known) {
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

    // MAIL-002 "category privacy controls" — a user-disabled domain is filtered out here, after
    // classification but before any per-domain extractor runs, so a disabled category never gets its
    // fields extracted at all (not just hidden from the Inbox afterward). A sender rule's forced category
    // (checked above) still respects this — if a user has disabled "bill" entirely, a sender rule that
    // forces "bill" shouldn't silently bypass that.
    if (user?.disabledMailCategories.length) {
      domains = domains.filter((d) => !user.disabledMailCategories.includes(d));
    }

    if (domains.length === 0 || (domains.includes("irrelevant") && domains.length === 1)) {
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

    if (ctx.attachments?.length) {
      await this.processAttachments(ctx.sourceEventId, ctx.ownerUserId, ctx.householdId, ctx.attachments);
    }

    await this.markProcessed(ctx.sourceEventId, filedAny ? "needs_review" : "filed");
  }

  /**
   * MAIL-004 "attachment intelligence" — attachments "inherit message provenance" by running through the
   * exact same upload+OCR pipeline as a manually-uploaded document (DocumentsService.upload()), linked to
   * whatever object(s) this message's own extraction just filed (looked up by sourceEventId rather than
   * threading resource ids back out of every extract* function — every inbox item this message produced
   * already carries this exact sourceEventId, see fileInboxItem below). A message that filed nothing (an
   * irrelevant attachment-bearing email, or every domain disabled/blocked) still gets its attachments
   * uploaded unlinked rather than silently dropped — the OCR text itself may be independently useful even
   * with nothing to attach it to. "Link to exact page/region" from the spec's fuller ask isn't attempted —
   * nothing in this codebase has a bounding-box/region data structure to link to; whole-document linking is
   * the honest, bounded version of this requirement.
   */
  private async processAttachments(
    sourceEventId: string,
    ownerUserId: string,
    householdId: string | null,
    attachments: Array<{ filename: string; mimeType: string; buffer: Buffer }>,
  ): Promise<void> {
    const [firstLinked] = await this.db
      .select({ linkedResourceId: schema.inboxItems.linkedResourceId })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.sourceEventId, sourceEventId)))
      .limit(1);

    for (const attachment of attachments) {
      if (!DOCUMENT_ATTACHMENT_MIME_TYPES.has(attachment.mimeType)) continue;
      try {
        await this.documents.upload({
          ownerUserId,
          householdId,
          title: attachment.filename,
          documentType: "other",
          mimeType: attachment.mimeType,
          buffer: attachment.buffer,
          linkedResourceId: firstLinked?.linkedResourceId ?? undefined,
        });
      } catch (err) {
        this.logger.warn(`Attachment upload failed for source event ${sourceEventId} ("${attachment.filename}"): ${String(err)}`);
      }
    }
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
    const confidenceBand = confidenceToBand(result.confidenceScore, await this.riskPolicy.thresholdsFor("purchase"));
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
    // §54.2 launch criteria #4 "conflicts are surfaced" — the fill-gaps-don't-clobber policy below is
    // still correct (a lower-quality later extraction shouldn't overwrite an already-confirmed total),
    // but it previously meant a genuinely different total for the *same order number* — two receipts
    // that disagree, not just one filling in what the other left blank — was silently discarded with no
    // signal at all. Only reachable via the exact-orderNumber match path: the amount/date fallback match
    // already requires the amount to agree to be considered "the same purchase" in the first place.
    const hasConflict = Boolean(existing) && amountsConflict(existing!.totalMinorUnits, result.data.totalAmountMinorUnits);
    const finalConfidenceBand = hasConflict ? "conflicting" : confidenceBand;
    if (existing) {
      await this.db
        .update(schema.purchases)
        .set({
          // Fill in gaps rather than clobber previously-confirmed values with a lower-quality later extraction.
          totalMinorUnits: existing.totalMinorUnits ?? result.data.totalAmountMinorUnits,
          taxMinorUnits: existing.taxMinorUnits ?? result.data.taxMinorUnits,
          shippingMinorUnits: existing.shippingMinorUnits ?? result.data.shippingMinorUnits,
          confidenceBand: finalConfidenceBand,
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
      await this.searchIndex.upsert({
        resourceType: "purchase",
        resourceId: purchaseId,
        ownerUserId: ctx.ownerUserId,
        householdId: ctx.householdId,
        title: merchantName,
        bodyText: result.data.orderNumber ?? "",
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
        const returnCaseId = generateId("returnCase");
        await this.db.insert(schema.returnCases).values({
          id: returnCaseId,
          purchaseId,
          state: "eligible",
          deadline,
          deadlineSort: temporalToSortDate(deadline),
          valueAtStakeMinorUnits: result.data.totalAmountMinorUnits,
          valueAtStakeCurrency: result.data.currency,
        });
        // §54.2 launch criteria #2/ASK-001 — return cases were never indexed, so Ask couldn't answer
        // "what's my return window for X" questions at all.
        await this.searchIndex.upsert({
          resourceType: "return_case",
          resourceId: returnCaseId,
          ownerUserId: ctx.ownerUserId,
          householdId: ctx.householdId,
          title: `Return window — ${merchantName}`,
          bodyText: result.data.orderNumber ?? "",
        });
      }
    }

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "purchase",
      summary: hasConflict
        ? `${merchantName} order ${result.data.orderNumber} has a conflicting total from a different source — review needed`
        : existing
          ? `${merchantName} order updated — ${result.data.orderNumber}`
          : `${merchantName} — ${result.data.lineItems[0]?.productLabel ?? "purchase"} detected`,
      linkedResourceType: "purchase",
      linkedResourceId: purchaseId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: hasConflict ? ["correct", "dismiss"] : existing ? ["confirm", "dismiss"] : ["confirm", "correct", "dismiss"],
      confidenceBand: finalConfidenceBand,
      isDuplicate: Boolean(existing),
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
    const confidenceBand = confidenceToBand(result.confidenceScore, await this.riskPolicy.thresholdsFor("shipment"));
    const estimatedDelivery = toTemporalValue(result.data.estimatedDelivery);

    // Best-effort link to the purchase this shipment belongs to — a carrier email rarely restates the
    // merchant the way a receipt does, so this matches on order number alone when the merchant can't be
    // resolved (§40.1: shipment auto-merge is by carrier+tracking; linking to a purchase is a weaker,
    // order-number-only match and stays unlinked rather than guessing when no order number is present).
    const linkedPurchase = result.data.orderNumber
      ? await this.findExistingPurchaseByOrderNumberOnly(ctx.ownerUserId, result.data.orderNumber)
      : null;

    const existingShipment = await this.findExistingShipment(ctx.ownerUserId, carrier, result.data.trackingNumber);
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
        ownerUserId: ctx.ownerUserId,
        householdId: ctx.householdId,
        purchaseId: linkedPurchase?.id ?? null,
        carrier,
        trackingNumber: result.data.trackingNumber,
        status: result.data.status ?? "in_transit",
        confidenceBand,
        estimatedDelivery,
        isGiftPrivate: false,
      });
    }
    // §54.2 launch criteria #2/ASK-001 — shipments were never indexed, so Ask couldn't answer "where's my
    // package"-style questions at all.
    await this.searchIndex.upsert({
      resourceType: "shipment",
      resourceId: shipmentId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      title: `${carrier} package`,
      bodyText: result.data.trackingNumber,
    });

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
      isDuplicate: Boolean(existingShipment),
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

  /**
   * Fixed a real cross-tenant bug: this used to match on `trackingNumber` alone with no owner scoping,
   * so two different users' packages sharing a tracking number (carrier number-range reuse isn't rare)
   * would collide onto the same shipment row. Scoped by owner now, same as every other domain's dedup.
   *
   * §40.1 also requires matching on carrier+tracking number, not tracking number alone — a reused tracking
   * number (carriers do recycle them, and an old/already-delivered shipment reusing a number is exactly the
   * case the spec calls out) would otherwise silently absorb an update meant for an unrelated new shipment.
   */
  private async findExistingShipment(ownerUserId: string, carrier: string, trackingNumber: string) {
    const [existing] = await this.db
      .select()
      .from(schema.shipments)
      .where(
        and(eq(schema.shipments.ownerUserId, ownerUserId), eq(schema.shipments.carrier, carrier), eq(schema.shipments.trackingNumber, trackingNumber)),
      )
      .limit(1);
    return existing ?? null;
  }

  /**
   * §40.1 subscription entity resolution — previously nonexistent: every renewal/trial/price-change email
   * for the same subscription created a brand-new recurringStreams+subscriptions row pair, silently
   * duplicating every recurring subscription on each new email about it. serviceLabel is encrypted (so it
   * can't be looked up by equality in SQL, same constraint noted throughout this file's other
   * encrypted-column comments) — a user's recurring-stream count is small and bounded, so this fetches all
   * of them and compares in memory, the same pattern findMatchingPurchaseLine below already uses.
   */
  private async findExistingRecurringStream(ownerUserId: string, serviceLabel: string) {
    const candidates = await this.db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, ownerUserId));
    const normalized = normalizeMerchantName(serviceLabel);
    return candidates.find((c) => normalizeMerchantName(c.serviceLabel) === normalized) ?? null;
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

    const confidenceBand = confidenceToBand(result.confidenceScore, await this.riskPolicy.thresholdsFor("bill"));
    const dueDate = toTemporalValue(result.data.dueDate);
    const dueDateSort = temporalToSortDate(dueDate);

    // MAIL-003 "thread-aware extraction" — a revised invoice/bill for the same biller shouldn't create a
    // sibling bill every time it's re-sent (a due-date push, a corrected amount). Same precision-first
    // ambiguity handling as findExistingPurchaseByAmountAndDate: more than one candidate means no match.
    const existing = await this.findExistingBill(ctx.ownerUserId, result.data.billerName, dueDateSort);
    const billId = existing?.id ?? generateId("bill");
    // §54.2 launch criteria #4 "conflicts are surfaced" — this used to unconditionally overwrite the due
    // date/amount on any re-match, silently discarding whichever value was right if two emails about the
    // same bill genuinely disagreed (a corrected invoice vs. a stale duplicate, not just a normal update).
    const hasConflict =
      Boolean(existing) &&
      (amountsConflict(existing!.amountDueMinorUnits, result.data.amountDueMinorUnits) || datesConflict(existing!.dueDateSort, dueDateSort));
    const finalConfidenceBand = hasConflict ? "conflicting" : confidenceBand;
    if (existing) {
      await this.db
        .update(schema.bills)
        .set({
          amountDueMinorUnits: result.data.amountDueMinorUnits ?? existing.amountDueMinorUnits,
          dueDate,
          dueDateSort,
          autopayBelieved: result.data.autopayMentioned ?? existing.autopayBelieved,
          confidenceBand: finalConfidenceBand,
          updatedAt: new Date(),
        })
        .where(eq(schema.bills.id, billId));
    } else {
      await this.db.insert(schema.bills).values({
        id: billId,
        ownerUserId: ctx.ownerUserId,
        householdId: ctx.householdId,
        billerLabel: result.data.billerName,
        amountDueMinorUnits: result.data.amountDueMinorUnits,
        amountDueCurrency: result.data.currency,
        confidenceBand,
        dueDate,
        dueDateSort,
        autopayBelieved: result.data.autopayMentioned,
      });
      await this.searchIndex.upsert({
        resourceType: "bill",
        resourceId: billId,
        ownerUserId: ctx.ownerUserId,
        householdId: ctx.householdId,
        title: result.data.billerName,
        bodyText: "",
      });
    }

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "bill",
      summary: hasConflict
        ? `${result.data.billerName} bill has conflicting amounts/dates from different sources — review needed`
        : existing
          ? `${result.data.billerName} bill updated`
          : `${result.data.billerName} bill detected`,
      linkedResourceType: "bill",
      linkedResourceId: billId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: hasConflict ? ["correct", "dismiss"] : existing ? ["confirm", "dismiss"] : ["confirm", "correct", "dismiss"],
      confidenceBand: finalConfidenceBand,
      isDuplicate: Boolean(existing),
    });
    return true;
  }

  /**
   * MAIL-003 "thread-aware extraction" — matches a revised bill from the same biller within a generous
   * two-week window (bills shift due dates more than purchase dates do on a reschedule). `billerLabel` is
   * encrypted, so the equality check happens in app code after Drizzle's transparent decrypt-on-select,
   * same approach as findMatchingPurchaseLine's already-established pattern for an encrypted field.
   */
  private async findExistingBill(ownerUserId: string, billerName: string, dueDateSort: Date | null) {
    if (!dueDateSort) return null;
    const windowStart = new Date(dueDateSort.getTime() - 14 * 86_400_000);
    const windowEnd = new Date(dueDateSort.getTime() + 14 * 86_400_000);
    const candidates = await this.db
      .select()
      .from(schema.bills)
      .where(and(eq(schema.bills.ownerUserId, ownerUserId), gte(schema.bills.dueDateSort, windowStart), lte(schema.bills.dueDateSort, windowEnd)));
    const normalized = billerName.trim().toLowerCase();
    const matches = candidates.filter((c) => c.billerLabel.trim().toLowerCase() === normalized);
    return matches.length === 1 ? matches[0] : null;
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

    const confidenceBand = confidenceToBand(result.confidenceScore, await this.riskPolicy.thresholdsFor("subscription"));
    // Unlike extractReceipt's merchant resolution, this is best-effort only — a subscription email doesn't
    // always name the billing merchant separately from the service itself (e.g. "Netflix" is both).
    const merchantId = result.data.merchantName ? await this.findOrCreateMerchant(result.data.merchantName) : null;
    const nextExpectedDate = toTemporalValue(result.data.nextBillingDate);
    const trialEndsAt = toTemporalValue(result.data.trialEndsDate);

    const existingStream = await this.findExistingRecurringStream(ctx.ownerUserId, result.data.serviceLabel);
    const recurringStreamId = existingStream?.id ?? generateId("recurringStream");
    if (existingStream) {
      await this.db
        .update(schema.recurringStreams)
        .set({
          merchantId: merchantId ?? existingStream.merchantId,
          cadence: result.data.cadence ?? existingStream.cadence,
          typicalAmountMinorUnits: result.data.amountMinorUnits ?? existingStream.typicalAmountMinorUnits,
          typicalAmountCurrency: result.data.currency ?? existingStream.typicalAmountCurrency,
          nextExpectedDate: nextExpectedDate ?? existingStream.nextExpectedDate,
          updatedAt: new Date(),
        })
        .where(eq(schema.recurringStreams.id, recurringStreamId));
    } else {
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
    }

    // A repeat email for the same stream updates the existing subscription row instead of creating a new
    // one — matching every other domain's dedup-then-update pattern (extractShipment above, extractBill/
    // extractReceipt below). "candidate" -> "trial" is the only state upgrade a fresh extraction can cause;
    // never downgrades an existing trial back to candidate, and never touches any state a real user action
    // may set in the future (subscriptions.state has no other real writer today).
    const [existingSubscription] = existingStream
      ? await this.db
          .select({ id: schema.subscriptions.id, state: schema.subscriptions.state })
          .from(schema.subscriptions)
          .where(eq(schema.subscriptions.recurringStreamId, recurringStreamId))
          .orderBy(desc(schema.subscriptions.createdAt))
          .limit(1)
      : [];
    const subscriptionId = existingSubscription?.id ?? generateId("subscription");
    if (existingSubscription) {
      await this.db
        .update(schema.subscriptions)
        .set({
          state: existingSubscription.state === "candidate" && result.data.isTrial ? "trial" : existingSubscription.state,
          confidenceBand,
          trialEndsAt: trialEndsAt ?? undefined,
          cancellationInstructionsUrl: result.data.cancellationInstructionsUrl ?? undefined,
          updatedAt: new Date(),
        })
        .where(eq(schema.subscriptions.id, subscriptionId));
    } else {
      await this.db.insert(schema.subscriptions).values({
        id: subscriptionId,
        recurringStreamId,
        state: result.data.isTrial ? "trial" : "candidate",
        confidenceBand,
        trialEndsAt,
        cancellationInstructionsUrl: result.data.cancellationInstructionsUrl,
      });
    }
    // §54.2 launch criteria #2/ASK-001 — subscriptions were never indexed, so Ask couldn't answer
    // questions about them at all.
    await this.searchIndex.upsert({
      resourceType: "subscription",
      resourceId: subscriptionId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      title: result.data.serviceLabel,
      bodyText: "",
    });

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "subscription",
      summary: existingSubscription ? `${result.data.serviceLabel} subscription updated` : `${result.data.serviceLabel} subscription detected`,
      linkedResourceType: "subscription",
      linkedResourceId: subscriptionId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: ["confirm", "correct", "dismiss"],
      confidenceBand,
      isDuplicate: Boolean(existingSubscription),
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

    const confidenceBand = confidenceToBand(result.confidenceScore, await this.riskPolicy.thresholdsFor("appointment"));
    const start = toTemporalValue(result.data.startDate, result.data.timezone);
    const startSort = temporalToSortDate(start);

    // MAIL-003 "thread-aware extraction" — "a changed flight, appointment reschedule... updates the
    // existing object" per spec. Deliberately doesn't require the date to match (the whole point of a
    // reschedule is that it changed) — only same owner + same title + not already cancelled + discovered
    // the same way this extractor discovers events (never merges into a directly-synced calendar event,
    // which uses `providerEventId` for its own dedup instead). Ambiguous (>1 match) means no merge, same
    // precision-first precedent as every other findExisting* helper here.
    const existing = await this.findExistingCalendarEvent(ctx.ownerUserId, result.data.title);
    const eventId = existing?.id ?? generateId("calendarEvent");
    const eventLocation = result.data.location ?? existing?.location ?? null;
    if (existing) {
      await this.db
        .update(schema.calendarEvents)
        .set({
          start,
          startSort,
          isAllDay: result.data.isAllDay,
          location: eventLocation,
          updatedAt: new Date(),
        })
        .where(eq(schema.calendarEvents.id, eventId));
    } else {
      await this.db.insert(schema.calendarEvents).values({
        id: eventId,
        ownerUserId: ctx.ownerUserId,
        householdId: ctx.householdId,
        title: result.data.title,
        start,
        startSort,
        isAllDay: result.data.isAllDay,
        location: eventLocation,
        source: "discovered_from_evidence",
        status: "confirmed",
        visibility: "private",
      });
    }
    await this.searchIndex.upsert({
      resourceType: "calendar_event",
      resourceId: eventId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      title: result.data.title,
      bodyText: eventLocation ?? "",
    });

    await this.fileInboxItem({
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      category: "appointment",
      summary: existing ? `${result.data.title} updated` : `${result.data.title} discovered`,
      linkedResourceType: "calendar_event",
      linkedResourceId: eventId,
      sourceEventId: ctx.sourceEventId,
      suggestedActions: existing ? ["confirm", "add_to_calendar", "dismiss"] : ["confirm", "add_to_calendar", "dismiss"],
      confidenceBand,
      isDuplicate: Boolean(existing),
    });
    return true;
  }

  private async findExistingCalendarEvent(ownerUserId: string, title: string) {
    const candidates = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          eq(schema.calendarEvents.ownerUserId, ownerUserId),
          eq(schema.calendarEvents.source, "discovered_from_evidence"),
          ne(schema.calendarEvents.status, "cancelled"),
        ),
      );
    const normalized = title.trim().toLowerCase();
    const matches = candidates.filter((c) => c.title.trim().toLowerCase() === normalized);
    return matches.length === 1 ? matches[0] : null;
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

    const confidenceBand = confidenceToBand(result.confidenceScore, await this.riskPolicy.thresholdsFor("warranty"));
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
    // §54.2 launch criteria #2/ASK-001 — warranties were never indexed at all, so Ask couldn't answer the
    // spec's own canonical example ("when does my fridge warranty expire") no matter how it was phrased.
    await this.searchIndex.upsert({
      resourceType: "warranty",
      resourceId: warrantyId,
      ownerUserId: ctx.ownerUserId,
      householdId: ctx.householdId,
      title: result.data.productLabel,
      bodyText: "",
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
    await this.searchIndex.upsert({
      resourceType: "calendar_event",
      resourceId: eventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      title: params.title,
      bodyText: params.location ?? "",
    });

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
   * Shared sync entry point for every "the source already IS a task" provider — Apple Reminders'
   * push-from-device EventKit sync and the Google Tasks/Microsoft To Do pull-based OAuth connectors alike
   * (mirrors `ingestFeedCalendarEvent`'s identical unification of ICS/Google/Microsoft Calendar). Writes
   * into `tasks`; `externalSyncProvider`/`externalSyncId` existed in the schema for exactly this dedup key.
   */
  async ingestFeedTask(params: {
    provider: string;
    ownerUserId: string;
    householdId: string | null;
    /** Null for a source with no `connections` row at all — e.g. a device's local reminders pushed
     * directly from the mobile app, which has no OAuth connection to represent as one. */
    connectionId: string | null;
    uid: string;
    title: string;
    dueIso: string | null;
    notes: string | null;
    completed: boolean;
  }): Promise<boolean> {
    const contentHash = createHash("sha256")
      .update(JSON.stringify({ title: params.title, dueIso: params.dueIso, notes: params.notes, completed: params.completed }))
      .digest("hex");
    // Falls back to ownerUserId when there's no connection row to scope by (a device's local reminders) —
    // still unique per user+provider+task, which is all this key needs to guarantee.
    const idempotencyKey = `${params.provider}:${params.connectionId ?? params.ownerUserId}:${params.uid}:${contentHash}`;

    const [existingSourceEvent] = await this.db
      .select({ id: schema.sourceEvents.id })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, idempotencyKey))
      .limit(1);
    if (existingSourceEvent) return false; // unchanged since the last sync

    const sourceEventId = generateId("sourceEvent");
    await this.db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      connectionId: params.connectionId,
      kind: "task_feed_item",
      contentHash,
      occurredAt: new Date(),
      idempotencyKey,
      processingState: "needs_review",
      subjectLine: params.title || null,
      snippet: params.notes || null,
    });

    const dueCondition: TemporalValue | null = params.dueIso
      ? { precision: "instant", instantUtc: new Date(params.dueIso).toISOString(), date: null, timezone: null, sourceText: null }
      : null;

    const [existingTask] = await this.db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.ownerUserId, params.ownerUserId), eq(schema.tasks.externalSyncProvider, params.provider), eq(schema.tasks.externalSyncId, params.uid)))
      .limit(1);

    const taskId = existingTask?.id ?? generateId("task");
    const state = params.completed ? "completed" : "open";
    if (existingTask) {
      await this.db
        .update(schema.tasks)
        .set({ title: params.title, dueCondition, dueSort: dueCondition ? temporalToSortDate(dueCondition) : null, consequence: params.notes, state, updatedAt: new Date() })
        .where(eq(schema.tasks.id, taskId));
    } else {
      await this.db.insert(schema.tasks).values({
        id: taskId,
        ownerUserId: params.ownerUserId,
        householdId: params.householdId,
        title: params.title,
        dueCondition,
        dueSort: dueCondition ? temporalToSortDate(dueCondition) : null,
        consequence: params.notes,
        state,
        externalSyncProvider: params.provider,
        externalSyncId: params.uid,
      });
    }

    if (!params.completed) {
      await this.fileInboxItem({
        ownerUserId: params.ownerUserId,
        householdId: params.householdId,
        category: "task",
        summary: existingTask ? `${params.title} updated on your synced task list` : `${params.title} added from your synced task list`,
        linkedResourceType: "task",
        linkedResourceId: taskId,
        sourceEventId,
        suggestedActions: ["dismiss"],
        confidenceBand: "verified",
      });
    }

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
    isDuplicate?: boolean;
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
      isDuplicate: params.isDuplicate ?? false,
    });

    if (params.confidenceBand === "high" || params.confidenceBand === "verified") {
      await this.notifications.createAndEnqueue({
        ownerUserId: params.ownerUserId,
        dedupeKey: `inbox-item:${inboxItemId}`,
        priority: "useful",
        title: "Veynlo found something new",
        body: params.summary,
        category: params.category,
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

  /**
   * MAIL-006 — matched against the address extracted from the just-parsed, still-in-memory From header,
   * never a DB-side query against `source_events.fromAddress` (encrypted, non-deterministic IV, so it
   * can't support equality lookups — same reasoning as users.email elsewhere in this codebase).
   */
  private async findSenderRule(ownerUserId: string, fromHeader: string) {
    const address = extractEmailAddress(fromHeader);
    if (!address) return null;
    const [rule] = await this.db
      .select()
      .from(schema.senderRules)
      .where(and(eq(schema.senderRules.ownerUserId, ownerUserId), eq(schema.senderRules.senderAddress, address)))
      .limit(1);
    return rule ?? null;
  }
}
