import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { decryptField } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

export interface TimelineItem {
  id: string;
  kind: "calendar_event" | "purchase" | "bill" | "document" | "return_case" | "warranty";
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
}

const PAGE_SIZE = 30;

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

  async getTimeline(ownerUserId: string, before: string | null): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
    const beforeTimestamp = before ? new Date(before) : null;

    const result = await this.db.execute<{
      id: string;
      kind: string;
      title: string;
      occurred_at: Date;
      resource_type: string;
      resource_id: string;
    }>(sql`
      select * from (
        select
          ce.id as id,
          'calendar_event' as kind,
          ce.title as title,
          ce.start_sort as occurred_at,
          'calendar_event' as resource_type,
          ce.id as resource_id
        from calendar_events ce
        where ce.owner_user_id = ${ownerUserId} and ce.start_sort is not null

        union all

        select
          p.id as id,
          'purchase' as kind,
          coalesce(m.display_name, p.order_number, 'Purchase') as title,
          p.purchase_date_sort as occurred_at,
          'purchase' as resource_type,
          p.id as resource_id
        from purchases p
        left join merchants m on m.id = p.merchant_id
        where p.owner_user_id = ${ownerUserId} and p.purchase_date_sort is not null

        union all

        select
          b.id as id,
          'bill' as kind,
          b.biller_label as title,
          b.due_date_sort as occurred_at,
          'bill' as resource_type,
          b.id as resource_id
        from bills b
        where b.owner_user_id = ${ownerUserId} and b.due_date_sort is not null

        union all

        select
          rc.id as id,
          'return_case' as kind,
          'Return deadline' as title,
          rc.deadline_sort as occurred_at,
          'return_case' as resource_type,
          rc.id as resource_id
        from return_cases rc
        inner join purchases p2 on p2.id = rc.purchase_id
        where p2.owner_user_id = ${ownerUserId} and rc.deadline_sort is not null

        union all

        select
          d.id as id,
          'document' as kind,
          d.title as title,
          d.created_at as occurred_at,
          'document' as resource_type,
          d.id as resource_id
        from documents d
        where d.owner_user_id = ${ownerUserId} and d.deleted_at is null

        union all

        select
          w.id as id,
          'warranty' as kind,
          w.product_label as title,
          w.expiration_date_sort as occurred_at,
          'warranty' as resource_type,
          w.id as resource_id
        from warranties w
        where w.owner_user_id = ${ownerUserId} and w.expiration_date_sort is not null
      ) timeline
      where ${beforeTimestamp}::timestamptz is null or occurred_at < ${beforeTimestamp}
      order by occurred_at desc
      limit ${PAGE_SIZE + 1}
    `);

    const rows = result.rows;
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // Raw sql`...` bypasses Drizzle's customType decode, so calendar_events.title, bills.biller_label,
    // warranties.product_label, and documents.title (all encrypted — see their schema definitions) come back
    // as ciphertext here and need manual decryption. purchases' title (merchant name / order number) and
    // return_cases' literal "Return deadline" are never encrypted, so those pass through unchanged.
    const ENCRYPTED_TITLE_KINDS = new Set(["calendar_event", "bill", "document", "warranty"]);
    const items: TimelineItem[] = page.map((row) => ({
      id: row.id,
      kind: row.kind as TimelineItem["kind"],
      title: ENCRYPTED_TITLE_KINDS.has(row.kind) ? decryptField(row.title) : row.title,
      occurredAt: new Date(row.occurred_at).toISOString(),
      resourceType: row.resource_type,
      resourceId: row.resource_id,
    }));

    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.occurredAt : null };
  }
}
