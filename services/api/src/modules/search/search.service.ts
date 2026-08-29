import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { generateId } from "@veynlo/core";
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

  /**
   * §ASK-002 — real Postgres full-text search via `search_documents` (see its schema comment): a plaintext
   * mirror of each resource's searchable text, kept in sync by `SearchIndexService` at every create/update
   * (ingestion, document upload/rename/new-version, merchant merge). Previously this fetched every owner's
   * row from each source table and matched substrings in application code — the ONLY way to search at all,
   * since bills.billerLabel/documents.title/calendarEvents.title are AES-GCM ciphertext and a SQL predicate
   * can't match plaintext against it. `search_documents` sidesteps that by existing specifically to be
   * searched (see its own schema comment on why its columns are deliberately unencrypted), so the match
   * itself can now be a real GIN-indexed `tsvector` query — stemming, ranking, phrase/exclusion syntax via
   * `websearch_to_tsquery` — instead of a linear substring scan capped at 200 rows per type.
   */
  async structuredSearch(userId: string, query: string) {
    const q = query.trim();
    if (!q) return { purchases: [], bills: [], documents: [], events: [] };

    const matches = await this.db.execute<{ resource_type: string; resource_id: string }>(sql`
      select resource_type, resource_id
      from search_documents
      where owner_user_id = ${userId}
        and deleted_at is null
        and search_vector @@ websearch_to_tsquery('english', ${q})
      order by ts_rank(search_vector, websearch_to_tsquery('english', ${q})) desc
      limit 100
    `);

    const idsByType = new Map<string, string[]>();
    for (const row of matches.rows) {
      const list = idsByType.get(row.resource_type) ?? [];
      list.push(row.resource_id);
      idsByType.set(row.resource_type, list);
    }
    const purchaseIds = idsByType.get("purchase") ?? [];
    const billIds = idsByType.get("bill") ?? [];
    const documentIds = idsByType.get("document") ?? [];
    const eventIds = idsByType.get("calendar_event") ?? [];

    const [purchases, bills, documents, events] = await Promise.all([
      purchaseIds.length ? this.db.select().from(schema.purchases).where(inArray(schema.purchases.id, purchaseIds)) : [],
      billIds.length ? this.db.select().from(schema.bills).where(inArray(schema.bills.id, billIds)) : [],
      documentIds.length ? this.db.select().from(schema.documents).where(inArray(schema.documents.id, documentIds)) : [],
      eventIds.length ? this.db.select().from(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)) : [],
    ]);

    // search_documents rows above already came back rank-ordered — re-sort each fetched set to match, since
    // the `IN (...)` selects above don't preserve that order themselves.
    const byRank = <T extends { id: string }>(rows: T[], ids: string[]): T[] => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      return [...rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    };

    return {
      purchases: byRank(purchases, purchaseIds),
      bills: byRank(bills, billIds),
      documents: byRank(documents, documentIds),
      events: byRank(events, eventIds),
    };
  }

  /**
   * ASK-001 — natural-language Ask, grounded in the same owner-scoped retrieval as structured search.
   * Documents (title + OCR'd body text) are included in the grounding context — previously excluded
   * entirely, so a question about something only stated in a scanned document/receipt had no way to be
   * answered even though the text had genuinely been extracted and stored.
   *
   * `history` (previous question/answer pairs, most recent last) is folded into the prompt so a follow-up
   * like "what about last month?" resolves against the prior turn — a real, if lightweight, take on
   * ASK-001's "refine" action. Deliberately NOT a server-persisted `query_session` (the spec's fuller
   * model): the caller already holds its own conversation history client-side (it has to, to render the
   * thread), so passing it through per-request avoids a whole session-storage/expiry design for the same
   * result. Capped to the last 5 turns so a long conversation doesn't unboundedly grow the prompt.
   */
  async ask(userId: string, question: string, history: Array<{ question: string; answer: string }> = []) {
    const [purchases, bills, events, merchants, documentRows] = await Promise.all([
      this.db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, userId)).limit(50),
      this.db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, userId)).limit(50),
      this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId)).limit(50),
      this.db.select().from(schema.merchants).limit(200),
      this.db
        .select({ document: schema.documents, version: schema.documentVersions })
        .from(schema.documents)
        .leftJoin(schema.documentVersions, eq(schema.documentVersions.id, schema.documents.currentVersionId))
        .where(eq(schema.documents.ownerUserId, userId))
        .limit(50),
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
      ...documentRows.map((r) => ({
        resourceType: "document",
        resourceId: r.document.id,
        // Truncated per item so a handful of long OCR'd documents don't dominate the prompt.
        text: `Document "${r.document.title}"${r.version?.ocrText ? `. Extracted text: ${r.version.ocrText.slice(0, 1000)}` : " (no extracted text available)."}`,
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

    const recentHistory = history.slice(-5);
    const historyBlock =
      recentHistory.length > 0
        ? `Conversation so far (most recent last) — use this to resolve follow-ups like "what about last month?":\n${recentHistory
            .map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`)
            .join("\n")}\n\n`
        : "";

    const result = await this.ai.extractStructured({
      extractorName: "ask_synthesis_v1",
      model: "reasoning",
      systemPrompt:
        "You are Ask Veynlo. Answer ONLY using the provided context items — never invent facts, dates, or " +
        "amounts not present in the context. If a conversation history is given, treat the new question as " +
        "a possible follow-up/refinement of that conversation. If the context doesn't support a confident " +
        "answer, set insufficientEvidence to true and say so plainly.",
      userContent:
        `${historyBlock}New question: ${question}\n\nContext items:\n` +
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

  /** ASK-001 "save query" — stores the question text only; re-running it (POST /v1/ask) always regenerates a fresh answer against current data. */
  async saveQuery(userId: string, questionText: string) {
    const id = generateId("savedQuery");
    await this.db.insert(schema.savedQueries).values({ id, ownerUserId: userId, questionText });
    return { id, questionText };
  }

  async listSavedQueries(userId: string) {
    return this.db.select().from(schema.savedQueries).where(eq(schema.savedQueries.ownerUserId, userId)).orderBy(desc(schema.savedQueries.createdAt));
  }

  async deleteSavedQuery(id: string, userId: string) {
    await this.db.delete(schema.savedQueries).where(and(eq(schema.savedQueries.id, id), eq(schema.savedQueries.ownerUserId, userId)));
  }
}
