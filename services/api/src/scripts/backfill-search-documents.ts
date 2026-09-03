/**
 * §44.4 "Search architecture" one-time backfill. `SearchIndexService.upsert` (see
 * ../modules/search/search-index.service.ts) only ever runs from a domain service's own create/update path
 * going forward — it has no way to reach back and index rows that already existed in the database before
 * this wiring shipped. Without this script, full-text search would silently work ONLY for anything
 * created/edited after deploy, while every pre-existing purchase/bill/document/etc. stayed permanently
 * invisible to `SearchService.structuredSearch`/`ask` — a much worse, much quieter gap than "search is
 * slow," since nothing would ever surface an error for it.
 *
 * Mirrors the exact same title/bodyText shape each wired call site builds (see search-index.service.ts's
 * own `SearchDocumentInput` doc comment, and each of IngestionService/DocumentsService/TripsService/
 * MemoriesService/PetsService/ScheduleService/CommerceService/HealthLogisticsService/InboxService's own
 * `searchIndex.upsert(...)` call sites) so a backfilled row and a freshly-written one are indistinguishable.
 *
 * Idempotent and safe to re-run at any time (e.g. after adding a new resource type, or after a bug fix to
 * one domain's projection shape) — `SearchIndexService.upsert` is itself an `ON CONFLICT` upsert keyed by
 * the same deterministic `${resourceType}:${resourceId}` id every write path already uses, so re-running
 * this script only ever overwrites with the current, correct values, never creates duplicates.
 *
 * Usage: pnpm --filter @veynlo/api run backfill-search-documents
 */
import "../config/load-env-file"; // must be the first import — see its own doc comment for why
import { eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { loadEnv } from "../config/env";
import { SearchIndexService, type SearchDocumentInput } from "../modules/search/search-index.service";

// Batched, not "fetch the whole table" — keeps memory bounded no matter how much history a production
// deployment has accumulated, matching §44.3's "avoid putting critical domain state only in ... indexes"
// carefulness applied to how this script itself touches the canonical tables (read in bounded slices).
const BATCH_SIZE = 500;

async function upsertAll(searchIndex: SearchIndexService, inputs: SearchDocumentInput[]): Promise<number> {
  for (const input of inputs) await searchIndex.upsert(input);
  return inputs.length;
}

/** Generic "process every row of a table, in bounded batches" helper. Plain `LIMIT`/`OFFSET` paging rather
 * than real keyset/cursor pagination: this script runs once, offline, and every `SearchIndexService.upsert`
 * call inside `process` is itself an idempotent `ON CONFLICT` upsert, so re-running the whole script (or
 * being re-run after a partial failure) is always safe — simplicity won out over cursor-correctness under
 * concurrent writes, acceptable for a one-time operator-run tool.
 */
async function runBatched<Row>(fetchPage: (offset: number, limit: number) => Promise<Row[]>, process: (rows: Row[]) => Promise<number>): Promise<number> {
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

async function backfillPurchases(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.purchases).orderBy(schema.purchases.id).limit(limit).offset(offset),
    async (rows) => {
      const merchantIds = [...new Set(rows.map((p) => p.merchantId).filter((id): id is string => id != null))];
      const merchants = merchantIds.length > 0 ? await db.select().from(schema.merchants).where(inArray(schema.merchants.id, merchantIds)) : [];
      const merchantById = new Map(merchants.map((m) => [m.id, m.displayName]));
      const purchaseIds = rows.map((p) => p.id);
      const lines = purchaseIds.length > 0 ? await db.select().from(schema.purchaseLines).where(inArray(schema.purchaseLines.purchaseId, purchaseIds)) : [];
      const linesByPurchase = new Map<string, string[]>();
      for (const line of lines) {
        const existing = linesByPurchase.get(line.purchaseId);
        if (existing) existing.push(line.productLabel);
        else linesByPurchase.set(line.purchaseId, [line.productLabel]);
      }
      return upsertAll(
        searchIndex,
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

async function backfillBills(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.bills).orderBy(schema.bills.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillDocuments(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.documents).orderBy(schema.documents.id).limit(limit).offset(offset),
    async (rows) => {
      const versionIds = rows.map((d) => d.currentVersionId).filter((id): id is string => id != null);
      const versions = versionIds.length > 0 ? await db.select().from(schema.documentVersions).where(inArray(schema.documentVersions.id, versionIds)) : [];
      const ocrByVersionId = new Map(versions.map((v) => [v.id, v.ocrText]));
      return upsertAll(
        searchIndex,
        rows.map((d) => ({
          resourceType: "document" as const,
          resourceId: d.id,
          ownerUserId: d.ownerUserId,
          householdId: d.householdId,
          sensitivity: d.sensitivity as SearchDocumentInput["sensitivity"],
          title: d.title,
          bodyText: (d.currentVersionId ? ocrByVersionId.get(d.currentVersionId) : null) ?? "",
        })),
      );
    },
  );
}

async function backfillCalendarEvents(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.calendarEvents).orderBy(schema.calendarEvents.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillWarranties(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.warranties).orderBy(schema.warranties.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillSubscriptions(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) =>
      db
        .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
        .from(schema.subscriptions)
        .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
        .orderBy(schema.subscriptions.id)
        .limit(limit)
        .offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillShipments(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.shipments).orderBy(schema.shipments.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillReturnCases(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) =>
      db
        .select({ returnCase: schema.returnCases, purchase: schema.purchases })
        .from(schema.returnCases)
        .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
        .orderBy(schema.returnCases.id)
        .limit(limit)
        .offset(offset),
    async (rows) => {
      const merchantIds = [...new Set(rows.map((r) => r.purchase.merchantId).filter((id): id is string => id != null))];
      const merchants = merchantIds.length > 0 ? await db.select().from(schema.merchants).where(inArray(schema.merchants.id, merchantIds)) : [];
      const merchantById = new Map(merchants.map((m) => [m.id, m.displayName]));
      return upsertAll(
        searchIndex,
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

async function backfillTrips(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.trips).orderBy(schema.trips.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillSavedMemories(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.savedMemories).orderBy(schema.savedMemories.id).limit(limit).offset(offset),
    async (rows) => {
      const sourceDocumentIds = rows.map((m) => m.sourceDocumentId).filter((id): id is string => id != null);
      const documents = sourceDocumentIds.length > 0 ? await db.select().from(schema.documents).where(inArray(schema.documents.id, sourceDocumentIds)) : [];
      const versionIds = documents.map((d) => d.currentVersionId).filter((id): id is string => id != null);
      const versions = versionIds.length > 0 ? await db.select().from(schema.documentVersions).where(inArray(schema.documentVersions.id, versionIds)) : [];
      const ocrByVersionId = new Map(versions.map((v) => [v.id, v.ocrText]));
      const versionIdByDocumentId = new Map(documents.map((d) => [d.id, d.currentVersionId]));
      return upsertAll(
        searchIndex,
        rows.map((m) => {
          const versionId = m.sourceDocumentId ? versionIdByDocumentId.get(m.sourceDocumentId) : null;
          const documentOcrText = versionId ? ocrByVersionId.get(versionId) : null;
          return {
            resourceType: "saved_memory" as const,
            resourceId: m.id,
            ownerUserId: m.ownerUserId,
            sensitivity: "standard" as const,
            title: m.title ?? "Saved item",
            bodyText: [m.userNotes, m.sourceUrl, m.rawText, documentOcrText].filter((v): v is string => Boolean(v)).join(" "),
            metadata: { category: m.category, relatedPersonLabel: m.relatedPersonLabel },
          };
        }),
      );
    },
  );
}

async function backfillPets(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.petProfiles).orderBy(schema.petProfiles.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function backfillHealthAppointments(db: Database, searchIndex: SearchIndexService): Promise<number> {
  return runBatched(
    (offset, limit) => db.select().from(schema.healthAppointments).orderBy(schema.healthAppointments.id).limit(limit).offset(offset),
    (rows) =>
      upsertAll(
        searchIndex,
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

async function main() {
  const db = createDbClient(loadEnv().DATABASE_URL);
  const searchIndex = new SearchIndexService(db);

  const results: Array<[string, number]> = [];
  results.push(["purchases", await backfillPurchases(db, searchIndex)]);
  results.push(["bills", await backfillBills(db, searchIndex)]);
  results.push(["documents", await backfillDocuments(db, searchIndex)]);
  results.push(["calendar_events", await backfillCalendarEvents(db, searchIndex)]);
  results.push(["warranties", await backfillWarranties(db, searchIndex)]);
  results.push(["subscriptions", await backfillSubscriptions(db, searchIndex)]);
  results.push(["shipments", await backfillShipments(db, searchIndex)]);
  results.push(["return_cases", await backfillReturnCases(db, searchIndex)]);
  results.push(["trips", await backfillTrips(db, searchIndex)]);
  results.push(["saved_memories", await backfillSavedMemories(db, searchIndex)]);
  results.push(["pets", await backfillPets(db, searchIndex)]);
  results.push(["health_appointments", await backfillHealthAppointments(db, searchIndex)]);

  console.log("Search backfill complete:");
  for (const [label, count] of results) console.log(`  ${label}: ${count}`);
  const total = results.reduce((sum, [, count]) => sum + count, 0);
  console.log(`Total search_documents rows written/refreshed: ${total}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Search backfill failed:", err);
  process.exit(1);
});
