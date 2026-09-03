import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/**
 * §44.4 "Full text ... document title, OCR, note, merchant, sender, model/serial" — the domains this table
 * mirrors, matching exactly what `SearchService.structuredSearch`/`ask` already cover (see that file's own
 * domain-coverage history/tests). Kept as a union (rather than plain `string`) purely so a typo in a call
 * site's `resourceType` is a compile error, not a silent no-op search gap of the kind §ASK-002's audit
 * comments describe finding live more than once in this codebase.
 */
export type SearchResourceType =
  | "purchase"
  | "bill"
  | "document"
  | "calendar_event"
  | "warranty"
  | "subscription"
  | "shipment"
  | "return_case"
  | "trip"
  | "saved_memory"
  | "pet"
  | "health_appointment";

/**
 * §45.4 "Sensitive-data tiers" — none of the 12 resource types above (besides `documents`, which already
 * carries its own per-row `sensitivity` column) has a live sensitivity column of its own, so callers pass
 * the tier explicitly per §45.4's own classification rather than this service guessing from field names.
 */
export type SearchSensitivityTier = "standard" | "sensitive" | "highly_sensitive" | "secret";

export interface SearchDocumentInput {
  resourceType: SearchResourceType;
  resourceId: string;
  ownerUserId: string;
  /** Null/omitted for resource types with no household concept (e.g. saved memories) or when the specific
   * row genuinely has none (e.g. a manually-added subscription — see commerce.service.ts's own comment). */
  householdId?: string | null;
  sensitivity: SearchSensitivityTier;
  /** Plain (never encrypted) display title — see schema/search.ts's column comment for why this table is
   * deliberately unencrypted unlike its source-of-truth columns. */
  title: string;
  /** Everything else worth matching on — OCR text, notes, merchant/provider names, tracking numbers, etc.
   * Optional because plenty of resources (e.g. a pet profile) have nothing beyond their title. */
  bodyText?: string;
  metadata?: Record<string, unknown>;
}

/**
 * §44.4 "Search architecture" / "Full text ... Postgres FTS initially" — the single reusable "upsert
 * searchable projection" entry point every domain service calls whenever it creates or updates a
 * searchable entity, so `search_documents` stays a live mirror of canonical data instead of accumulating
 * one-off write paths that silently drift out of sync (the same "one shared helper, called from every
 * domain service" shape as `AttentionService.fileIfNew`). `SearchService` then queries this table with
 * real Postgres full-text search (`to_tsquery`/`ts_rank` against the generated `search_vector` column)
 * instead of the previous in-app word-overlap ranker over bounded per-domain fetches.
 *
 * NOT wired here: semantic (embedding-similarity) search per §44.4's "Semantic" mode — that needs a
 * configured, paid embedding provider, which is credential-blocked/out of scope for this phase.
 * `search_documents.embedding` stays null/unused; a future phase can populate it without touching this
 * upsert's shape (`embedding` isn't part of `SearchDocumentInput` on purpose).
 *
 * Deliberately module-free of anything beyond `DATABASE` (a `@Global()`-provided token) so any domain
 * module can import `SearchIndexModule` without risking a circular-import edge back into this one.
 */
@Injectable()
export class SearchIndexService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Upserts a resource's search document, keyed by a DETERMINISTIC id (`${resourceType}:${resourceId}`)
   * rather than a randomly generated one. That makes "create or refresh this resource's projection"
   * naturally idempotent through a single `ON CONFLICT` target — no separate look-up-then-branch, and no
   * extra unique index needed beyond the primary key search_documents already has.
   */
  async upsert(input: SearchDocumentInput): Promise<void> {
    const id = searchDocumentId(input.resourceType, input.resourceId);
    const now = new Date();
    const row = {
      ownerUserId: input.ownerUserId,
      householdId: input.householdId ?? null,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      sensitivity: input.sensitivity,
      title: input.title,
      bodyText: input.bodyText ?? "",
      metadata: input.metadata ?? {},
      indexedAt: now,
      deletedAt: null,
    };
    await this.db
      .insert(schema.searchDocuments)
      .values({ id, ...row })
      .onConflictDoUpdate({ target: schema.searchDocuments.id, set: row });
  }

  /**
   * Soft-deletes a resource's search document (mirrors `search_documents.deletedAt`, matching how most of
   * the domains it indexes soft-delete rather than hard-delete their own rows — §44.3 "Vector embeddings
   * and search documents ... must be deleted/reindexed with canonical data"). Safe to call for a resource
   * that was never indexed (e.g. created before this wiring existed and not yet backfilled) — the `WHERE`
   * simply matches zero rows.
   */
  async markDeleted(resourceType: SearchResourceType, resourceId: string): Promise<void> {
    await this.db
      .update(schema.searchDocuments)
      .set({ deletedAt: new Date() })
      .where(eq(schema.searchDocuments.id, searchDocumentId(resourceType, resourceId)));
  }
}

export function searchDocumentId(resourceType: SearchResourceType, resourceId: string): string {
  return `${resourceType}:${resourceId}`;
}
