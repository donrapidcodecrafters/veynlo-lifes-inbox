import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { decryptField } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

export type TimelineKind = "calendar_event" | "purchase" | "bill" | "document" | "return_case" | "warranty" | "shipment";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
  /** TIME-001 "collapse under one semantic event" — a shipment whose purchase is also in this page gets
   * folded under that purchase instead of appearing as its own top-level entry. Only ever populated on a
   * "purchase" item; every other kind's relatedItems is always empty. */
  relatedItems: TimelineItem[];
}

const PAGE_SIZE = 30;
const EXPORT_ROW_CAP = 5000;

const ENCRYPTED_TITLE_KINDS = new Set(["calendar_event", "bill", "document", "warranty"]);

function decodeRow(row: { id: string; kind: string; title: string; occurred_at: Date; resource_type: string; resource_id: string; parent_purchase_id: string | null }) {
  return {
    id: row.id,
    kind: row.kind as TimelineKind,
    title: ENCRYPTED_TITLE_KINDS.has(row.kind) ? decryptField(row.title) : row.title,
    occurredAt: new Date(row.occurred_at).toISOString(),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    parentPurchaseId: row.parent_purchase_id,
  };
}

/** Folds any shipment whose parent purchase is also present in `rows` under that purchase's `relatedItems`, removing it as a standalone top-level entry. A shipment whose purchase isn't in this same page/range is left standalone — collapsing can't reach across a page boundary. */
function collapseShipments(rows: ReturnType<typeof decodeRow>[]): TimelineItem[] {
  const shipmentsByPurchaseId = new Map<string, ReturnType<typeof decodeRow>[]>();
  for (const row of rows) {
    if (row.kind === "shipment" && row.parentPurchaseId) {
      const existing = shipmentsByPurchaseId.get(row.parentPurchaseId) ?? [];
      existing.push(row);
      shipmentsByPurchaseId.set(row.parentPurchaseId, existing);
    }
  }
  const purchaseIdsWithCollapsedShipments = new Set(
    rows.filter((r) => r.kind === "purchase" && shipmentsByPurchaseId.has(r.id)).map((r) => r.id),
  );
  return rows
    .filter((row) => !(row.kind === "shipment" && row.parentPurchaseId && purchaseIdsWithCollapsedShipments.has(row.parentPurchaseId)))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      occurredAt: row.occurredAt,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      relatedItems: (row.kind === "purchase" ? shipmentsByPurchaseId.get(row.id) : undefined)?.map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        occurredAt: s.occurredAt,
        resourceType: s.resourceType,
        resourceId: s.resourceId,
        relatedItems: [],
      })) ?? [],
    }));
}

/**
 * §TIME-001 — a unified, chronological read projection over existing
 * canonical tables. Deliberately NOT a separate `timeline_events` writer
 * pipeline yet (§ "timeline service... never becomes the system of record
 * itself") — this assembles the view at read time via UNION ALL, which is
 * correct and simple for MVP volumes; a materialized projection is a
 * ROADMAP item once query cost at scale justifies it.
 */
@Injectable()
export class TimelineService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** The shared UNION ALL projection across every domain — a plain `sql` fragment (not a full query) reused by both the paginated getTimeline() and the date-range exportRange(). */
  private timelineUnion(ownerUserId: string) {
    return sql`
      select
        ce.id as id, 'calendar_event' as kind, ce.title as title, ce.start_sort as occurred_at,
        'calendar_event' as resource_type, ce.id as resource_id, null::text as parent_purchase_id
      from calendar_events ce
      where ce.owner_user_id = ${ownerUserId} and ce.start_sort is not null

      union all

      select
        p.id as id, 'purchase' as kind, coalesce(m.display_name, p.order_number, 'Purchase') as title,
        p.purchase_date_sort as occurred_at, 'purchase' as resource_type, p.id as resource_id, null::text as parent_purchase_id
      from purchases p
      left join merchants m on m.id = p.merchant_id
      where p.owner_user_id = ${ownerUserId} and p.purchase_date_sort is not null

      union all

      select
        b.id as id, 'bill' as kind, b.biller_label as title, b.due_date_sort as occurred_at,
        'bill' as resource_type, b.id as resource_id, null::text as parent_purchase_id
      from bills b
      where b.owner_user_id = ${ownerUserId} and b.due_date_sort is not null

      union all

      select
        rc.id as id, 'return_case' as kind, 'Return deadline' as title, rc.deadline_sort as occurred_at,
        'return_case' as resource_type, rc.id as resource_id, null::text as parent_purchase_id
      from return_cases rc
      inner join purchases p2 on p2.id = rc.purchase_id
      where p2.owner_user_id = ${ownerUserId} and rc.deadline_sort is not null

      union all

      select
        d.id as id, 'document' as kind, d.title as title, d.created_at as occurred_at,
        'document' as resource_type, d.id as resource_id, null::text as parent_purchase_id
      from documents d
      where d.owner_user_id = ${ownerUserId} and d.deleted_at is null

      union all

      select
        w.id as id, 'warranty' as kind, w.product_label as title, w.expiration_date_sort as occurred_at,
        'warranty' as resource_type, w.id as resource_id, null::text as parent_purchase_id
      from warranties w
      where w.owner_user_id = ${ownerUserId} and w.expiration_date_sort is not null

      union all

      select
        s.id as id, 'shipment' as kind, s.carrier as title, coalesce(s.delivered_at, s.updated_at) as occurred_at,
        'shipment' as resource_type, s.id as resource_id, s.purchase_id as parent_purchase_id
      from shipments s
      inner join purchases p3 on p3.id = s.purchase_id
      where p3.owner_user_id = ${ownerUserId}
    `;
  }

  async getTimeline(
    ownerUserId: string,
    before: string | null,
    kind: TimelineKind | null = null,
  ): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
    const beforeTimestamp = before ? new Date(before) : null;

    const result = await this.db.execute<{
      id: string;
      kind: string;
      title: string;
      occurred_at: Date;
      resource_type: string;
      resource_id: string;
      parent_purchase_id: string | null;
    }>(sql`
      select * from (${this.timelineUnion(ownerUserId)}) timeline
      where (${beforeTimestamp}::timestamptz is null or occurred_at < ${beforeTimestamp})
        and (
          ${kind}::text is null
          or kind = ${kind}
          -- A shipment must still pass through when filtering to "purchase" specifically, or
          -- collapseShipments() below has nothing to fold under its parent purchase.
          or (${kind}::text = 'purchase' and kind = 'shipment')
        )
      order by occurred_at desc
      limit ${PAGE_SIZE + 1}
    `);

    const rows = result.rows;
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // Raw sql`...` bypasses Drizzle's customType decode, so calendar_events.title, bills.biller_label,
    // warranties.product_label, and documents.title (all encrypted — see their schema definitions) come back
    // as ciphertext here and need manual decryption. purchases'/shipments'/return_cases' titles are never
    // encrypted, so those pass through unchanged.
    const decoded = page.map(decodeRow);
    const items = collapseShipments(decoded);

    // The cursor must be the LAST item's occurredAt from the pre-collapse page (not post-collapse — a
    // collapsed shipment is still "consumed" from this page and must not be re-fetched on the next one).
    const lastRaw = decoded[decoded.length - 1];
    return { items, nextCursor: hasMore && lastRaw ? lastRaw.occurredAt : null };
  }

  /** TIME-001 "export date range" — a flat CSV (no collapsing; a range export is meant to be a complete raw record, not a display convenience) capped at EXPORT_ROW_CAP rows so an unbounded range can't produce an unbounded response. */
  async exportRange(ownerUserId: string, from: string, to: string): Promise<string> {
    const fromTimestamp = new Date(from);
    const toTimestamp = new Date(to);

    const result = await this.db.execute<{
      id: string;
      kind: string;
      title: string;
      occurred_at: Date;
      resource_type: string;
      resource_id: string;
      parent_purchase_id: string | null;
    }>(sql`
      select * from (${this.timelineUnion(ownerUserId)}) timeline
      where occurred_at >= ${fromTimestamp} and occurred_at <= ${toTimestamp}
      order by occurred_at desc
      limit ${EXPORT_ROW_CAP}
    `);

    const decoded = result.rows.map(decodeRow);
    const header = "date,kind,title\n";
    const csvEscape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const body = decoded.map((row) => `${row.occurredAt},${csvEscape(row.kind)},${csvEscape(row.title)}`).join("\n");
    return header + body;
  }
}
