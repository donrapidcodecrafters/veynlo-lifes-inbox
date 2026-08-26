import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AnthropicExtractionService } from "../intelligence/anthropic-extraction.service";

const AskAnswerSchema = z.object({
  answer: z.string().describe("Concise, direct answer. If the evidence doesn't support a confident answer, say so plainly instead of guessing."),
  evidenceResourceIds: z.array(z.string()).describe("resourceId values from the provided context that support the answer"),
  insufficientEvidence: z.boolean().describe("true if the provided context does not contain enough information to answer confidently"),
});

/**
 * §ASK-001/002 — structured search is deterministic SQL over authorized,
 * owner-scoped rows; Ask layers a grounded synthesis step on top and always
 * cites which retrieved rows it used. Authorization is enforced by scoping
 * every query to the requesting user before any row reaches the model
 * (§ "Authorization before retrieval" — never the reverse).
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ai: AnthropicExtractionService,
  ) {}

  async structuredSearch(userId: string, query: string) {
    const pattern = `%${query}%`;
    const [purchases, bills, documents, events] = await Promise.all([
      this.db
        .select()
        .from(schema.purchases)
        .where(and(eq(schema.purchases.ownerUserId, userId), ilike(schema.purchases.orderNumber, pattern)))
        .limit(20),
      this.db
        .select()
        .from(schema.bills)
        .where(and(eq(schema.bills.ownerUserId, userId), ilike(schema.bills.billerLabel, pattern)))
        .limit(20),
      this.db
        .select()
        .from(schema.documents)
        .where(and(eq(schema.documents.ownerUserId, userId), ilike(schema.documents.title, pattern)))
        .limit(20),
      this.db
        .select()
        .from(schema.calendarEvents)
        .where(and(eq(schema.calendarEvents.ownerUserId, userId), ilike(schema.calendarEvents.title, pattern)))
        .limit(20),
    ]);
    return { purchases, bills, documents, events };
  }

  /** ASK-001 — natural-language Ask, grounded in the same owner-scoped retrieval as structured search. */
  async ask(userId: string, question: string) {
    const [purchases, bills, events, merchants] = await Promise.all([
      this.db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, userId)).limit(50),
      this.db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, userId)).limit(50),
      this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId)).limit(50),
      this.db.select().from(schema.merchants).limit(200),
    ]);

    const merchantById = new Map(merchants.map((m) => [m.id, m.displayName]));
    const context = [
      ...purchases.map((p) => ({
        resourceType: "purchase",
        resourceId: p.id,
        text: `Purchase from ${p.merchantId ? merchantById.get(p.merchantId) ?? "unknown merchant" : "unknown merchant"}, order ${p.orderNumber ?? "n/a"}, total ${p.totalMinorUnits ? (p.totalMinorUnits / 100).toFixed(2) : "unknown"} ${p.totalCurrency ?? ""}, state ${p.state}.`,
      })),
      ...bills.map((b) => ({
        resourceType: "bill",
        resourceId: b.id,
        text: `Bill from ${b.billerLabel}, amount due ${b.amountDueMinorUnits ? (b.amountDueMinorUnits / 100).toFixed(2) : "unknown"} ${b.amountDueCurrency ?? ""}.`,
      })),
      ...events.map((e) => ({
        resourceType: "calendar_event",
        resourceId: e.id,
        text: `Event "${e.title}"${e.location ? ` at ${e.location}` : ""}.`,
      })),
    ];

    if (context.length === 0) {
      return {
        answer: "I don't have any information connected yet to answer that. Try connecting an email account or adding items manually.",
        evidence: [],
        insufficientEvidence: true,
      };
    }

    if (!this.ai.isConfigured()) {
      return {
        answer: "Ask isn't available yet — the AI provider isn't configured on this deployment.",
        evidence: [],
        insufficientEvidence: true,
      };
    }

    const result = await this.ai.extractStructured({
      extractorName: "ask_synthesis_v1",
      model: "reasoning",
      systemPrompt:
        "You are Ask Veynlo. Answer ONLY using the provided context items — never invent facts, dates, or " +
        "amounts not present in the context. If the context doesn't support a confident answer, set " +
        "insufficientEvidence to true and say so plainly.",
      userContent:
        `Question: ${question}\n\nContext items:\n` +
        context.map((c) => `[${c.resourceType}:${c.resourceId}] ${c.text}`).join("\n"),
      schema: AskAnswerSchema,
      toolDescription: "Emit the grounded answer.",
    });

    if (!result) {
      return { answer: "I couldn't generate an answer right now. Please try again.", evidence: [], insufficientEvidence: true };
    }

    const evidence = context.filter((c) => result.data.evidenceResourceIds.includes(c.resourceId));
    return { answer: result.data.answer, evidence, insufficientEvidence: result.data.insufficientEvidence };
  }
}
