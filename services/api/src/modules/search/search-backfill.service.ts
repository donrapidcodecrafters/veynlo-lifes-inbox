import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { SearchIndexService, type SearchDocumentInput } from "./search-index.service";

/** Bounded slices rather than "fetch the whole table" — memory stays flat no matter how much history a
 * deployment has accumulated. */
const BATCH_SIZE = 500;

export interface SearchBackfillResult {
  /** Documents written (created or refreshed), by resource type. */
  indexed: Record<string, number>;
  /** Index rows retired because their resource no longer exists live, by resource type. */
  retired: Record<string, number>;
}

/**
 * Reconciles `search_documents` with the canonical tables.
 *
 * This is the projection that used to live in `scripts/backfill-search-documents.ts` as an operator-run
 * one-off. It moved here for two reasons, both of which were real gaps rather than tidying:
 *
 *  1. **Nothing ever ran it.** The index is written forward-only — each domain service upserts on create
 *     and update, and nothing reconstructs a document after the fact — so any row written around a domain
 *     service stays permanently unfindable until a human remembers to run a script. Measured on a freshly
 *     seeded database: 8 of 10 resource types entirely absent from the index, 3 of the demo user's 41
 *     records searchable. The seed is the obvious case, but the same applies to an importer, a migration,
 *     a manual repair, a failed `upsert` (awaited, but not transactional with the write it follows, and
 *     never retried), or a newly added `SearchResourceType`. A queue tick now drives this daily; the
 *     script remains as the on-demand entry point and calls straight into here.
 *  2. **It only ever added.** A record deleted after being indexed left its document behind. That can't
 *     leak content — `structuredSearch` re-fetches every hit from the source table scoped to the owner —
 *     but the orphan still occupies one of its domain's RESULTS_PER_DOMAIN ranked slots, so a deleted
 *     record silently pushes a live one out of the results. `retireOrphans` is the counterpart.
 *
 * Each projection below deliberately mirrors the shape its own domain service's `searchIndex.upsert(...)`
 * call site builds, so a reconciled row and a freshly written one are indistinguishable. Divergence here
 * would be worse than no backfill: a record would be findable by different words depending on which path
 * happened to write it.
 *
 * Every write is an `ON CONFLICT` upsert keyed by the deterministic `${resourceType}:${resourceId}`, so the
 * whole pass is idempotent and safe to re-run at any time, including after a partial failure.
 */
@Injectable()
export class SearchBackfillService {
  private readonly logger = new Logger(SearchBackfillService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SearchIndexService) private readonly index: SearchIndexService,
  ) {}

  /** A full reconciliation: reindex everything, then retire documents whose record is gone. */
  async run(): Promise<SearchBackfillResult> {
    const indexed = await this.reindexAll();
    const retired = await this.retireOrphans();
    const total = Object.values(indexed).reduce((a, b) => a + b, 0);
    const retiredTotal = Object.values(retired).reduce((a, b) => a + b, 0);
    this.logger.log(`search backfill complete: ${total} document(s) written/refreshed, ${retiredTotal} retired`);
    return { indexed, retired };
  }

  /**
   * Only LIVE records are projected. Reindexing a soft-deleted/merged-away one and leaving retireOrphans to
   * clean up after would still reach the right end state, but it churns a write and a retire on every pass
   * and — worse — makes a deleted record briefly searchable in the window between the two phases. Caught by
   * a merged-away pet that this pass re-retired every single run.
   */
  async reindexAll(): Promise<Record<string, number>> {
    return {
      purchase: await this.reindexPurchases(),
      bill: await this.reindexBills(),
      document: await this.reindexDocuments(),
      calendar_event: await this.reindexCalendarEvents(),
      warranty: await this.reindexWarranties(),
      subscription: await this.reindexSubscriptions(),
      shipment: await this.reindexShipments(),
      return_case: await this.reindexReturnCases(),
      trip: await this.reindexTrips(),
      saved_memory: await this.reindexSavedMemories(),
      pet: await this.reindexPets(),
      health_appointment: await this.reindexHealthAppointments(),
    };
  }

  /**
   * Soft-deletes every live index row whose resource no longer exists, or exists only as a soft-deleted /
   * merged-away record.
   *
   * One `NOT EXISTS` per resource type rather than loading every id into memory: the join predicate is
   * exactly the "is this still a live record?" condition each domain's own read paths use, and Postgres
   * evaluates it against the source table's primary key.
   *
   * Unlike DataIntegrityService's orphan scan — which is log-only because an opaque id can't be proven
   * stale — this check is exact (the id either resolves in its own typed table or it does not), and
   * `markDeleted` is a soft delete, so repairing automatically here is both safe and reversible.
   */
  async retireOrphans(): Promise<Record<string, number>> {
    const liveWhere: Array<[string, ReturnType<typeof sql>]> = [
      ["purchase", sql`SELECT 1 FROM purchases t WHERE t.id = d.resource_id`],
      ["bill", sql`SELECT 1 FROM bills t WHERE t.id = d.resource_id`],
      ["document", sql`SELECT 1 FROM documents t WHERE t.id = d.resource_id AND t.deleted_at IS NULL`],
      ["calendar_event", sql`SELECT 1 FROM calendar_events t WHERE t.id = d.resource_id`],
      ["warranty", sql`SELECT 1 FROM warranties t WHERE t.id = d.resource_id`],
      ["subscription", sql`SELECT 1 FROM subscriptions t WHERE t.id = d.resource_id`],
      ["shipment", sql`SELECT 1 FROM shipments t WHERE t.id = d.resource_id`],
      ["return_case", sql`SELECT 1 FROM return_cases t WHERE t.id = d.resource_id`],
      ["trip", sql`SELECT 1 FROM trips t WHERE t.id = d.resource_id AND t.deleted_at IS NULL`],
      ["saved_memory", sql`SELECT 1 FROM saved_memories t WHERE t.id = d.resource_id`],
      ["pet", sql`SELECT 1 FROM pet_profiles t WHERE t.id = d.resource_id AND t.deleted_at IS NULL AND t.merged_into_pet_id IS NULL`],
      ["health_appointment", sql`SELECT 1 FROM health_appointments t WHERE t.id = d.resource_id AND t.deleted_at IS NULL`],
    ];

    const retired: Record<string, number> = {};
    for (const [resourceType, exists] of liveWhere) {
      const result = await this.db.execute(sql`
        UPDATE search_documents d
        SET deleted_at = now()
        WHERE d.resource_type = ${resourceType}
          AND d.deleted_at IS NULL
          AND NOT EXISTS (${exists})
      `);
      const count = Number((result as { rowCount?: number | null }).rowCount ?? 0);
      if (count > 0) retired[resourceType] = count;
    }
    return retired;
  }

  // --- projections -------------------------------------------------------------------------------------

  private async upsertAll(inputs: SearchDocumentInput[]): Promise<number> {
    for (const input of inputs) await this.index.upsert(input);
    return inputs.length;
  }

  /**
   * "Process every row of a table, in bounded batches." Plain LIMIT/OFFSET paging rather than real keyset
   * pagination: every write inside `process` is an idempotent upsert, so a re-run after a partial failure
   * is always safe, and a row shifting between pages under concurrent writes costs at most one missed
   * refresh that the next daily pass picks up.
   */
  private async runBatched<Row>(
    fetchPage: (offset: number, limit: number) => Promise<Row[]>,
    process: (rows: Row[]) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    let offset = 0;
    for (;;) {
      const rows = await fetchPage(offset, BATCH_SIZE);
      if (rows.length === 0) break;
      total += await process(rows);
      if (rows.length < BATCH_SIZE) break;
      offset += rows.length;
    }
    return total;
  }

  private reindexPurchases(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.purchases).orderBy(schema.purchases.id).limit(limit).offset(offset),
      async (rows) => {
        const merchantById = await this.merchantNames(rows.map((p) => p.merchantId));
        const purchaseIds = rows.map((p) => p.id);
        const lines =
          purchaseIds.length > 0 ? await this.db.select().from(schema.purchaseLines).where(inArray(schema.purchaseLines.purchaseId, purchaseIds)) : [];
        const linesByPurchase = new Map<string, string[]>();
        for (const line of lines) {
          const existing = linesByPurchase.get(line.purchaseId);
          if (existing) existing.push(line.productLabel);
          else linesByPurchase.set(line.purchaseId, [line.productLabel]);
        }
        return this.upsertAll(
          rows.map((p) => ({
            resourceType: "purchase" as const,
            resourceId: p.id,
            ownerUserId: p.ownerUserId,
            householdId: p.householdId,
            sensitivity: "sensitive" as const,
            title: `${p.merchantId ? (merchantById.get(p.merchantId) ?? "Unknown merchant") : "Unknown merchant"}${p.orderNumber ? ` — order ${p.orderNumber}` : ""}`,
            bodyText: (linesByPurchase.get(p.id) ?? []).join(", "),
            metadata: { orderNumber: p.orderNumber },
          })),
        );
      },
    );
  }

  private reindexBills(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.bills).orderBy(schema.bills.id).limit(limit).offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((b) => ({
            resourceType: "bill" as const,
            resourceId: b.id,
            ownerUserId: b.ownerUserId,
            householdId: b.householdId,
            sensitivity: "sensitive" as const,
            title: b.billerLabel,
            bodyText: b.billerCategory ?? "",
          })),
        ),
    );
  }

  /** Body text is the current version's OCR, matching DocumentsService.processOcr's re-upsert — a scanned
   * receipt has to be findable by its extracted text, not only its title. Sensitivity comes from the stored
   * column for the same reason: that re-upsert is the last word on a document's shape. */
  private reindexDocuments(): Promise<number> {
    return this.runBatched(
      (offset, limit) =>
        this.db.select().from(schema.documents).where(isNull(schema.documents.deletedAt)).orderBy(schema.documents.id).limit(limit).offset(offset),
      async (rows) => {
        const ocrByDocumentId = await this.ocrTextByDocumentId(rows);
        return this.upsertAll(
          rows.map((d) => ({
            resourceType: "document" as const,
            resourceId: d.id,
            ownerUserId: d.ownerUserId,
            householdId: d.householdId,
            sensitivity: d.sensitivity as SearchDocumentInput["sensitivity"],
            title: d.title,
            bodyText: ocrByDocumentId.get(d.id) ?? "",
          })),
        );
      },
    );
  }

  private reindexCalendarEvents(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.calendarEvents).orderBy(schema.calendarEvents.id).limit(limit).offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((e) => ({
            resourceType: "calendar_event" as const,
            resourceId: e.id,
            ownerUserId: e.ownerUserId,
            householdId: e.householdId,
            sensitivity: "sensitive" as const,
            title: e.title,
            bodyText: e.location ?? "",
          })),
        ),
    );
  }

  private reindexWarranties(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.warranties).orderBy(schema.warranties.id).limit(limit).offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((w) => ({
            resourceType: "warranty" as const,
            resourceId: w.id,
            ownerUserId: w.ownerUserId,
            householdId: w.householdId,
            sensitivity: "standard" as const,
            title: w.productLabel,
          })),
        ),
    );
  }

  private reindexSubscriptions(): Promise<number> {
    return this.runBatched(
      (offset, limit) =>
        this.db
          .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
          .from(schema.subscriptions)
          .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
          .orderBy(schema.subscriptions.id)
          .limit(limit)
          .offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((r) => ({
            resourceType: "subscription" as const,
            resourceId: r.subscription.id,
            ownerUserId: r.stream.ownerUserId,
            householdId: r.stream.householdId,
            sensitivity: "sensitive" as const,
            title: r.stream.serviceLabel,
          })),
        ),
    );
  }

  private reindexShipments(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.shipments).orderBy(schema.shipments.id).limit(limit).offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((s) => ({
            resourceType: "shipment" as const,
            resourceId: s.id,
            ownerUserId: s.ownerUserId,
            householdId: null,
            sensitivity: "standard" as const,
            title: `${s.carrier} — ${s.trackingNumber}`,
            bodyText: s.status,
          })),
        ),
    );
  }

  /** return_cases carry no owner column — ownership comes through the parent purchase, the same way every
   * read path for this table joins back to `purchases`. */
  private reindexReturnCases(): Promise<number> {
    return this.runBatched(
      (offset, limit) =>
        this.db
          .select({ returnCase: schema.returnCases, purchase: schema.purchases })
          .from(schema.returnCases)
          .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
          .orderBy(schema.returnCases.id)
          .limit(limit)
          .offset(offset),
      async (rows) => {
        const merchantById = await this.merchantNames(rows.map((r) => r.purchase.merchantId));
        return this.upsertAll(
          rows.map((r) => ({
            resourceType: "return_case" as const,
            resourceId: r.returnCase.id,
            ownerUserId: r.purchase.ownerUserId,
            householdId: r.purchase.householdId,
            sensitivity: "sensitive" as const,
            title: `Return case — ${r.purchase.merchantId ? (merchantById.get(r.purchase.merchantId) ?? "Unknown merchant") : "Unknown merchant"}${r.purchase.orderNumber ? ` order ${r.purchase.orderNumber}` : ""}`,
            metadata: { purchaseId: r.purchase.id },
          })),
        );
      },
    );
  }

  private reindexTrips(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.trips).where(isNull(schema.trips.deletedAt)).orderBy(schema.trips.id).limit(limit).offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((t) => ({
            resourceType: "trip" as const,
            resourceId: t.id,
            ownerUserId: t.ownerUserId,
            householdId: t.householdId,
            sensitivity: "sensitive" as const,
            title: t.label ?? (t.destinationLabel ? `Trip to ${t.destinationLabel}` : "Trip"),
            bodyText: t.destinationLabel ?? "",
          })),
        ),
    );
  }

  private reindexSavedMemories(): Promise<number> {
    return this.runBatched(
      (offset, limit) => this.db.select().from(schema.savedMemories).orderBy(schema.savedMemories.id).limit(limit).offset(offset),
      async (rows) => {
        const sourceDocumentIds = rows.map((m) => m.sourceDocumentId).filter((id): id is string => id != null);
        const documents =
          sourceDocumentIds.length > 0 ? await this.db.select().from(schema.documents).where(inArray(schema.documents.id, sourceDocumentIds)) : [];
        const ocrByDocumentId = await this.ocrTextByDocumentId(documents);
        return this.upsertAll(
          rows.map((m) => ({
            resourceType: "saved_memory" as const,
            resourceId: m.id,
            ownerUserId: m.ownerUserId,
            sensitivity: "standard" as const,
            title: m.title ?? "Saved item",
            bodyText: [m.userNotes, m.sourceUrl, m.rawText, m.sourceDocumentId ? ocrByDocumentId.get(m.sourceDocumentId) : null]
              .filter((v): v is string => Boolean(v))
              .join(" "),
            metadata: { category: m.category, relatedPersonLabel: m.relatedPersonLabel },
          })),
        );
      },
    );
  }

  private reindexPets(): Promise<number> {
    return this.runBatched(
      (offset, limit) =>
        this.db
          .select()
          .from(schema.petProfiles)
          .where(and(isNull(schema.petProfiles.deletedAt), isNull(schema.petProfiles.mergedIntoPetId)))
          .orderBy(schema.petProfiles.id)
          .limit(limit)
          .offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((p) => ({
            resourceType: "pet" as const,
            resourceId: p.id,
            ownerUserId: p.ownerUserId,
            householdId: p.householdId,
            sensitivity: "sensitive" as const,
            title: p.label,
            bodyText: [p.species, p.breed].filter(Boolean).join(" "),
          })),
        ),
    );
  }

  private reindexHealthAppointments(): Promise<number> {
    return this.runBatched(
      (offset, limit) =>
        this.db
          .select()
          .from(schema.healthAppointments)
          .where(isNull(schema.healthAppointments.deletedAt))
          .orderBy(schema.healthAppointments.id)
          .limit(limit)
          .offset(offset),
      (rows) =>
        this.upsertAll(
          rows.map((a) => ({
            resourceType: "health_appointment" as const,
            resourceId: a.id,
            ownerUserId: a.ownerUserId,
            householdId: a.householdId,
            sensitivity: "highly_sensitive" as const,
            title: a.providerName ?? a.appointmentType ?? "Health appointment",
            bodyText: [a.appointmentType, a.location, a.prepInstructions].filter(Boolean).join(" — "),
          })),
        ),
    );
  }

  // --- shared lookups ----------------------------------------------------------------------------------

  private async merchantNames(ids: Array<string | null>): Promise<Map<string, string>> {
    const merchantIds = [...new Set(ids.filter((id): id is string => id != null))];
    if (merchantIds.length === 0) return new Map();
    const merchants = await this.db.select().from(schema.merchants).where(inArray(schema.merchants.id, merchantIds));
    return new Map(merchants.map((m) => [m.id, m.displayName]));
  }

  /** OCR text of each document's *current* version, keyed by document id. */
  private async ocrTextByDocumentId(documents: Array<{ id: string; currentVersionId: string | null }>): Promise<Map<string, string>> {
    const versionIds = documents.map((d) => d.currentVersionId).filter((id): id is string => id != null);
    if (versionIds.length === 0) return new Map();
    const versions = await this.db.select().from(schema.documentVersions).where(inArray(schema.documentVersions.id, versionIds));
    const ocrByVersionId = new Map(versions.map((v) => [v.id, v.ocrText]));
    const out = new Map<string, string>();
    for (const d of documents) {
      const text = d.currentVersionId ? ocrByVersionId.get(d.currentVersionId) : null;
      if (text) out.set(d.id, text);
    }
    return out;
  }
}
