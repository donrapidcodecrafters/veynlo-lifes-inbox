import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

const SAMPLE_SIZE = 5;

export interface OrphanFinding {
  checkedCount: number;
  orphanCount: number;
  /** Every orphaned row's own id (not just the logged sample) — the source of truth for callers/tests; the log line only ever prints up to SAMPLE_SIZE of these. */
  orphanIds: string[];
}

export interface DataIntegrityScanResult {
  attentionItemLinkOrphans: OrphanFinding;
  notificationAttentionItemOrphans: OrphanFinding;
  jsonbArrayOrphans: Record<string, OrphanFinding>;
}

/**
 * attention_items.linked_resource_type values this app actually files — AttentionService.fileIfNew's own
 * call sites are the only writer of this table outside tests, so this list is exhaustive, not a guess.
 * "person" and "recurring_stream" links fold extra state into linked_resource_id (`${id}:${year}` /
 * `${id}:${expectedDateKey}`), so the real target id is everything before the first ":".
 */
const ATTENTION_LINK_TYPES = ["bill", "return_case", "warranty", "document", "person", "recurring_stream"] as const;

function baseId(linkedResourceId: string): string {
  const i = linkedResourceId.indexOf(":");
  return i === -1 ? linkedResourceId : linkedResourceId.slice(0, i);
}

function sample(ids: string[]): string[] {
  return ids.slice(0, SAMPLE_SIZE);
}

/**
 * §Operations "data-integrity/orphan-check job" — several relationship columns in this app
 * (attention_items.linked_resource_id, notifications.linked_attention_item_id, and the JSONB
 * "*_entity_ids" arrays on purchases/bills/warranties/documents/tasks/calendar_events) have no real DB
 * foreign-key constraint, so nothing ever prevents them from dangling after their target row is deleted
 * (see e.g. DocumentsService.deleteDocument, PeopleService.deletePerson — neither scrubs the other side).
 * Log-only for now, not auto-repair: IDs are opaque generateId-prefixed strings, so a scan can't cheaply
 * prove a stale id isn't some other still-valid resource typo'd into the wrong field — auto-deleting risks
 * a false positive destroying real data. This finds and reports real orphans (counts + sample ids) so
 * findings can be validated before any future auto-repair work, same posture as dataRetentionScan just
 * logging what it processes.
 */
@Injectable()
export class DataIntegrityService {
  private readonly logger = new Logger(DataIntegrityService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async scanForOrphans(): Promise<DataIntegrityScanResult> {
    const attentionItemLinkOrphans = await this.scanAttentionItemLinks();
    const notificationAttentionItemOrphans = await this.scanNotificationLinks();
    const jsonbArrayOrphans = await this.scanJsonbArrayLinks();

    this.logger.log(
      `Data integrity scan complete — attention_items orphans: ${attentionItemLinkOrphans.orphanCount}/${attentionItemLinkOrphans.checkedCount}, notifications orphans: ${notificationAttentionItemOrphans.orphanCount}/${notificationAttentionItemOrphans.checkedCount}`,
    );
    return { attentionItemLinkOrphans, notificationAttentionItemOrphans, jsonbArrayOrphans };
  }

  /** Check 1 — attention_items whose (linked_resource_type, linked_resource_id) doesn't resolve to a live row. */
  private async scanAttentionItemLinks(): Promise<OrphanFinding> {
    const rows = await this.db
      .select({ id: schema.attentionItems.id, linkedResourceType: schema.attentionItems.linkedResourceType, linkedResourceId: schema.attentionItems.linkedResourceId })
      .from(schema.attentionItems)
      .where(and(isNotNull(schema.attentionItems.linkedResourceType), isNotNull(schema.attentionItems.linkedResourceId)));

    const idsByType = new Map<string, string[]>();
    for (const type of ATTENTION_LINK_TYPES) idsByType.set(type, []);
    for (const row of rows) {
      const type = row.linkedResourceType!;
      if (!idsByType.has(type)) idsByType.set(type, []);
      idsByType.get(type)!.push(baseId(row.linkedResourceId!));
    }

    const [billIds, returnCaseIds, warrantyIds, documentIds, personIds, recurringStreamIds] = await Promise.all([
      existingIds(this.db.select({ id: schema.bills.id }).from(schema.bills).where(inArray(schema.bills.id, idsByType.get("bill")!))),
      existingIds(this.db.select({ id: schema.returnCases.id }).from(schema.returnCases).where(inArray(schema.returnCases.id, idsByType.get("return_case")!))),
      existingIds(this.db.select({ id: schema.warranties.id }).from(schema.warranties).where(inArray(schema.warranties.id, idsByType.get("warranty")!))),
      existingIds(this.db.select({ id: schema.documents.id }).from(schema.documents).where(inArray(schema.documents.id, idsByType.get("document")!))),
      existingIds(this.db.select({ id: schema.canonicalEntities.id }).from(schema.canonicalEntities).where(inArray(schema.canonicalEntities.id, idsByType.get("person")!))),
      existingIds(this.db.select({ id: schema.recurringStreams.id }).from(schema.recurringStreams).where(inArray(schema.recurringStreams.id, idsByType.get("recurring_stream")!))),
    ]);
    const resolvedByType: Record<string, Set<string>> = {
      bill: billIds,
      return_case: returnCaseIds,
      warranty: warrantyIds,
      document: documentIds,
      person: personIds,
      recurring_stream: recurringStreamIds,
    };

    const orphanIds: string[] = [];
    for (const row of rows) {
      const type = row.linkedResourceType!;
      const resolved = resolvedByType[type];
      // An unrecognized linkedResourceType (none exist today, see ATTENTION_LINK_TYPES' comment) has
      // nothing to resolve against — flagged as an orphan rather than silently skipped.
      if (!resolved || !resolved.has(baseId(row.linkedResourceId!))) orphanIds.push(row.id);
    }

    if (orphanIds.length > 0) {
      this.logger.warn(`Data integrity: ${orphanIds.length}/${rows.length} attention_items point at a resource that no longer exists. Sample ids: ${sample(orphanIds).join(", ")}`);
    }
    return { checkedCount: rows.length, orphanCount: orphanIds.length, orphanIds };
  }

  /** Check 2 — notifications.linked_attention_item_id that doesn't resolve to a live attention_items row. */
  private async scanNotificationLinks(): Promise<OrphanFinding> {
    const rows = await this.db
      .select({ id: schema.notifications.id, linkedAttentionItemId: schema.notifications.linkedAttentionItemId })
      .from(schema.notifications)
      .where(isNotNull(schema.notifications.linkedAttentionItemId));

    const attentionItemIds = rows.map((r) => r.linkedAttentionItemId!);
    const resolved = await existingIds(this.db.select({ id: schema.attentionItems.id }).from(schema.attentionItems).where(inArray(schema.attentionItems.id, attentionItemIds)));

    const orphanIds = rows.filter((r) => !resolved.has(r.linkedAttentionItemId!)).map((r) => r.id);
    if (orphanIds.length > 0) {
      this.logger.warn(`Data integrity: ${orphanIds.length}/${rows.length} notifications point at an attention_item that no longer exists. Sample ids: ${sample(orphanIds).join(", ")}`);
    }
    return { checkedCount: rows.length, orphanCount: orphanIds.length, orphanIds };
  }

  /**
   * Check 3 — the JSONB "*_entity_ids" arrays. These aren't person-only despite PeopleService.linkedItems
   * only ever reading them for that one case, so an id is only flagged as orphaned if it resolves in NONE
   * of the tables these arrays are ever observed pointing at (people-links via
   * ScheduleService.setEventPersonLink, plus the broader purchase/bill/warranty/document/calendar_event/
   * task set documents' upload-time `linkedResourceId` and the web app's history-section attach flow can
   * point at).
   *
   * Originally this scanned six arrays. `purchases`, `bills` and `warranties` carried their own
   * `linkedEntityIds` on the pre-2026-08-26 line of history; on the current schema they do not, so those
   * three sources are gone — not disabled, genuinely absent (verified against packages/db/src/schema/
   * commerce.ts). The remaining four are every entity-link array the current schema actually has.
   * `people.relatedEntityIds` is included, which the original predated.
   */
  private async scanJsonbArrayLinks(): Promise<Record<string, OrphanFinding>> {
    const sources: { key: string; rows: { id: string; linkedIds: string[] }[] }[] = await Promise.all([
      this.db
        .select({ id: schema.people.id, linkedIds: schema.people.relatedEntityIds })
        .from(schema.people)
        .then((rows) => ({ key: "people.relatedEntityIds", rows: rows.filter((r) => r.linkedIds.length > 0) })),
      this.db
        .select({ id: schema.documents.id, linkedIds: schema.documents.linkedEntityIds })
        .from(schema.documents)
        .then((rows) => ({ key: "documents.linkedEntityIds", rows: rows.filter((r) => r.linkedIds.length > 0) })),
      this.db
        .select({ id: schema.tasks.id, linkedIds: schema.tasks.relatedEntityIds })
        .from(schema.tasks)
        .then((rows) => ({ key: "tasks.relatedEntityIds", rows: rows.filter((r) => r.linkedIds.length > 0) })),
      this.db
        .select({ id: schema.calendarEvents.id, linkedIds: schema.calendarEvents.relatedEntityIds })
        .from(schema.calendarEvents)
        .then((rows) => ({ key: "calendarEvents.relatedEntityIds", rows: rows.filter((r) => r.linkedIds.length > 0) })),
    ]);

    const candidateIds = [...new Set(sources.flatMap((s) => s.rows.flatMap((r) => r.linkedIds)))];
    const [personIds, purchaseIds, billIds, warrantyIds, documentIds, calendarEventIds, taskIds] = await Promise.all([
      existingIds(this.db.select({ id: schema.canonicalEntities.id }).from(schema.canonicalEntities).where(inArray(schema.canonicalEntities.id, candidateIds))),
      existingIds(this.db.select({ id: schema.purchases.id }).from(schema.purchases).where(inArray(schema.purchases.id, candidateIds))),
      existingIds(this.db.select({ id: schema.bills.id }).from(schema.bills).where(inArray(schema.bills.id, candidateIds))),
      existingIds(this.db.select({ id: schema.warranties.id }).from(schema.warranties).where(inArray(schema.warranties.id, candidateIds))),
      existingIds(this.db.select({ id: schema.documents.id }).from(schema.documents).where(inArray(schema.documents.id, candidateIds))),
      existingIds(this.db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(inArray(schema.calendarEvents.id, candidateIds))),
      existingIds(this.db.select({ id: schema.tasks.id }).from(schema.tasks).where(inArray(schema.tasks.id, candidateIds))),
    ]);
    const resolved = new Set<string>([...personIds, ...purchaseIds, ...billIds, ...warrantyIds, ...documentIds, ...calendarEventIds, ...taskIds]);

    const result: Record<string, OrphanFinding> = {};
    for (const source of sources) {
      const orphanRowIds = source.rows.filter((r) => r.linkedIds.some((id) => !resolved.has(id))).map((r) => r.id);
      if (orphanRowIds.length > 0) {
        this.logger.warn(`Data integrity: ${orphanRowIds.length}/${source.rows.length} ${source.key} rows contain an id that resolves to nothing. Sample ids: ${sample(orphanRowIds).join(", ")}`);
      }
      result[source.key] = { checkedCount: source.rows.length, orphanCount: orphanRowIds.length, orphanIds: orphanRowIds };
    }
    return result;
  }
}

async function existingIds(query: Promise<{ id: string }[]>): Promise<Set<string>> {
  const rows = await query;
  return new Set(rows.map((r) => r.id));
}
