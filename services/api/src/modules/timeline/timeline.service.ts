import { Inject, Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { decryptField } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";

export interface TimelineItem {
  id: string;
  kind:
    | "calendar_event"
    | "task"
    | "purchase"
    | "bill"
    | "document"
    | "return_case"
    | "warranty"
    | "school_event"
    | "trip_segment"
    | "pet_vaccination"
    | "pet_refill_reminder"
    | "health_appointment"
    | "health_refill_reminder";
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
}

const PAGE_SIZE = 30;

// Documents §27 "Health Logistics" HLTH-002 — mirrors DocumentsService's own HEALTH_DOCUMENT_TYPES
// (insurance_card/eob) exactly: these never become visible via plain household membership, even when
// visibility is "household". Kept as a local literal rather than importing DocumentsService's export —
// same "a few lines of logic isn't worth a cross-module coupling" precedent PetsService/EmergencyBinderService
// already set for duplicating a small filter instead of reaching into another module's service class.
const HEALTH_DOCUMENT_TYPES_SQL = sql`('insurance_card', 'eob')`;

/**
 * §TIME-001 — a unified, chronological read projection over existing
 * canonical tables. Deliberately NOT a separate `timeline_events` writer
 * pipeline yet (§ "timeline service... never becomes the system of record
 * itself") — this assembles the view at read time via UNION ALL, which is
 * correct and simple for MVP volumes; a materialized projection is a
 * ROADMAP item once query cost at scale justifies it.
 *
 * PHASE 3 COVERAGE — found live during a fresh adversarial pass: the household-visibility fix above (see
 * this class's own history) only ever touched the original six domains (calendar_events/purchases/bills/
 * return_cases/documents/warranties) that existed when Timeline was first built. School, Trips, Pets, and
 * Health Logistics shipped later and were simply never wired in — not a visibility bug this time, a
 * straight coverage gap: TIME-001 itself says "a chronological audit and memory layer across ALL domains",
 * and HOME-002 explicitly names "school/family obligations" and `trip_segments` as things the chronological
 * view should merge. A household's shared school event or trip never showed up here at all, even though it
 * showed up correctly on that domain's own list endpoint. Six more UNION branches below, one per domain,
 * each reusing that domain's OWN established access-control shape exactly (never inventing a new one):
 *   - school_event   — SchoolService.ownerOrHousehold's shape: owner OR (schedule:read delegate OR active
 *                       member), status "confirmed" only (mirrors SchoolService.listSchoolEvents).
 *   - trip_segment    — TripsService.ownerOrDelegatedHousehold's shape (trips:read delegate OR active
 *                       member) applied at the parent trip's owner/household, plus a direct "trip"
 *                       resourceGrant (TripsService.listTrips also ORs this in) — deleted trips excluded.
 *   - pet_vaccination /
 *     pet_refill_reminder — PetsService.ownerOrDelegatedHousehold's shape (reuses "commerce:read", exactly
 *                       like PetsService's own doc comment explains for why pets don't need their own
 *                       delegation scope), plus a direct "pet" resourceGrant (PetsService.list ORs this in
 *                       too). Only rows already assigned to a pet (petProfileId set) — an unassigned
 *                       candidate is still an inbox triage item, not a confirmed fact belonging on a
 *                       timeline, exactly like an unconfirmed purchase never appearing here either.
 *   - health_appointment /
 *     health_refill_reminder — HealthLogisticsService.appointmentAccessCondition/refillAccessCondition's
 *                       shape EXACTLY, including what they deliberately do NOT do: plain active household
 *                       membership is NEVER OR'd in here, matching HealthLogisticsService's own doc comment
 *                       ("private by default; strong access controls" — a health-logistics row must not
 *                       become visible just because someone is active in the household the way a shared
 *                       grocery list does). Only ownership, an explicit "health:read" delegation AND
 *                       row visibility "household" (appointments only — refill reminders have no visibility
 *                       column, delegation alone gates them, exactly like HealthLogisticsService), or a
 *                       direct "health_appointment" resourceGrant ever surface another household member's
 *                       row here.
 *
 * ROUND-3 COVERAGE — found live during a full end-to-end household+automation journey: `tasks` was never
 * one of the UNION branches above (not in the original six, not in the Phase 3 sweep that added School/
 * Trips/Pets/Health) — confirmed live that an automation-approved `add_task` run's task showed up
 * correctly in `GET /v1/tasks` (Life) but never in `GET /v1/timeline`, even though its sibling
 * `add_calendar_event` action's row DOES appear (calendar_events was always covered). This isn't specific
 * to automation-created tasks — no task from ANY source (manual creation, Apple Reminders sync via
 * `ingestDeviceReminder`, automation) has ever appeared on Timeline. Added a `task` branch reusing
 * ScheduleService's own tasks access shape exactly (see `personalToday`'s identical `ownerOrHousehold`
 * condition just above `home()` in attention.service.ts, and ScheduleService's own list method): owner OR
 * (schedule:read delegate OR active member) OR directly assigned to the viewer (`assignedToUserId`) — the
 * same `scheduleHouseholdIds` set calendar_events already computes, reused rather than duplicated. `tasks`
 * has no `deletedAt`/`visibility` column (unlike calendar_events/documents), so unlike those two branches
 * there's no soft-delete or private-row filter to add. Ordered by `coalesce(due_sort, created_at)` — most
 * tasks have a due date and slot in chronologically by that; an undated task (this repo's automation
 * `add_task` action never sets one) falls back to when it was created, the same precedent `document`'s own
 * branch already uses for a domain with no natural "occurred at" date of its own.
 *
 * Saved Memories (SAVE-001..008) deliberately stay OUT of Timeline: `saved_memories` has no `householdId`
 * column at all (verified in schema/memories.ts) — it's a strictly per-user "things I intentionally want to
 * remember" store, not a household-shared "things that happened" domain, and the top-level IA (§6.1) already
 * gives it its own dedicated "Saved" destination distinct from "Timeline". Folding it in here would mix two
 * genuinely different concepts (an intentional bookmark vs. a chronological life event) for no product
 * benefit, since nothing about it is missing a household-visibility story the way School/Trips/Pets/Health
 * were.
 */
@Injectable()
export class TimelineService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
  ) {}

  /** `col in (id1, id2, ...)`, or a plain `false` when there are no ids — a literal that's always safe to
   * OR in, so every UNION branch below can unconditionally splice its access clause without a separate
   * "empty list" code path. Used for both household-id sets and resourceGrant id sets — both are just
   * "is this column's value one of these ids" checks. */
  private inClause(column: string, ids: string[]): SQL {
    if (ids.length === 0) return sql`false`;
    return sql`${sql.raw(column)} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
  }

  async getTimeline(ownerUserId: string, before: string | null): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
    const beforeTimestamp = before ? new Date(before) : null;

    // §TIME-001 "Household-shared timeline is assembled per viewer authorization" — found live during a
    // requirements re-audit: this whole query was scoped by `owner_user_id = ${ownerUserId}` alone across
    // every UNION branch, the exact "forgot to OR in household visibility" bug class already found and
    // fixed this session in Commerce/Schedule/Lists/Assets/Documents (see e.g.
    // CommerceService.ownerOrDelegatedHousehold's own doc comment) — except here nobody had fixed it,
    // because Timeline is a read-only aggregation service with no `ownerOrDelegatedHousehold` helper of its
    // own to have been copy-pasted from. A household member's shared purchase, shared calendar event, or
    // shared document from a co-member never appeared on their Timeline at all, even though the exact same
    // rows already show up correctly in that domain's own list endpoint. Computed once here (one query, six
    // UNION branches) rather than once per domain, using each domain's own established delegation scope
    // (schedule:read / commerce:read / documents:read) OR'd with plain active membership, matching every
    // other domain service's `ownerOrDelegatedHousehold` shape.
    const [
      scheduleDelegated,
      commerceDelegated,
      documentsDelegated,
      tripsDelegated,
      healthDelegated,
      memberIds,
      tripGrantedIds,
      petGrantedIds,
      healthApptGrantedIds,
    ] = await Promise.all([
      this.households.delegatedHouseholdIds(ownerUserId, "schedule:read"),
      this.households.delegatedHouseholdIds(ownerUserId, "commerce:read"),
      this.households.delegatedHouseholdIds(ownerUserId, "documents:read"),
      this.households.delegatedHouseholdIds(ownerUserId, "trips:read"),
      this.households.delegatedHouseholdIds(ownerUserId, "health:read"),
      this.households.activeHouseholdIds(ownerUserId),
      this.sharing.grantedResourceIds("trip", ownerUserId),
      this.sharing.grantedResourceIds("pet", ownerUserId),
      this.sharing.grantedResourceIds("health_appointment", ownerUserId),
    ]);
    const scheduleHouseholdIds = [...new Set([...scheduleDelegated, ...memberIds])];
    const commerceHouseholdIds = [...new Set([...commerceDelegated, ...memberIds])];
    const documentsHouseholdIds = [...new Set([...documentsDelegated, ...memberIds])];
    const tripsHouseholdIds = [...new Set([...tripsDelegated, ...memberIds])];
    // Deliberately NOT OR'd with `memberIds` — see this class's own doc comment on why Health Logistics is
    // the one domain where plain active membership must never grant visibility on its own.
    const healthHouseholdIds = [...new Set(healthDelegated)];

    const result = await this.db.execute<{
      id: string;
      kind: string;
      title: string | null;
      occurred_at: Date;
      resource_type: string;
      resource_id: string;
      fallback_label: string | null;
    }>(sql`
      select * from (
        select
          ce.id as id,
          'calendar_event' as kind,
          ce.title as title,
          ce.start_sort as occurred_at,
          'calendar_event' as resource_type,
          ce.id as resource_id,
          null::text as fallback_label
        from calendar_events ce
        where ce.start_sort is not null
          and (
            ce.owner_user_id = ${ownerUserId}
            or (${this.inClause("ce.household_id", scheduleHouseholdIds)} and ce.visibility <> 'private')
          )

        union all

        select
          t.id as id,
          'task' as kind,
          t.title as title,
          coalesce(t.due_sort, t.created_at) as occurred_at,
          'task' as resource_type,
          t.id as resource_id,
          null::text as fallback_label
        from tasks t
        where (
          t.owner_user_id = ${ownerUserId}
          or ${this.inClause("t.household_id", scheduleHouseholdIds)}
          or t.assigned_to_user_id = ${ownerUserId}
        )

        union all

        select
          p.id as id,
          'purchase' as kind,
          coalesce(m.display_name, p.order_number, 'Purchase') as title,
          p.purchase_date_sort as occurred_at,
          'purchase' as resource_type,
          p.id as resource_id,
          null::text as fallback_label
        from purchases p
        left join merchants m on m.id = p.merchant_id
        where p.purchase_date_sort is not null
          and (p.owner_user_id = ${ownerUserId} or ${this.inClause("p.household_id", commerceHouseholdIds)})

        union all

        select
          b.id as id,
          'bill' as kind,
          b.biller_label as title,
          b.due_date_sort as occurred_at,
          'bill' as resource_type,
          b.id as resource_id,
          null::text as fallback_label
        from bills b
        where b.due_date_sort is not null
          and (b.owner_user_id = ${ownerUserId} or ${this.inClause("b.household_id", commerceHouseholdIds)})

        union all

        select
          rc.id as id,
          'return_case' as kind,
          'Return deadline' as title,
          rc.deadline_sort as occurred_at,
          'return_case' as resource_type,
          rc.id as resource_id,
          null::text as fallback_label
        from return_cases rc
        inner join purchases p2 on p2.id = rc.purchase_id
        where rc.deadline_sort is not null
          and (p2.owner_user_id = ${ownerUserId} or ${this.inClause("p2.household_id", commerceHouseholdIds)})

        union all

        select
          d.id as id,
          'document' as kind,
          d.title as title,
          d.created_at as occurred_at,
          'document' as resource_type,
          d.id as resource_id,
          null::text as fallback_label
        from documents d
        where d.deleted_at is null
          and (
            d.owner_user_id = ${ownerUserId}
            or (
              ${this.inClause("d.household_id", documentsHouseholdIds)}
              and d.visibility <> 'private'
              and d.document_type not in ${HEALTH_DOCUMENT_TYPES_SQL}
            )
          )

        union all

        select
          w.id as id,
          'warranty' as kind,
          w.product_label as title,
          w.expiration_date_sort as occurred_at,
          'warranty' as resource_type,
          w.id as resource_id,
          null::text as fallback_label
        from warranties w
        where w.expiration_date_sort is not null
          and (w.owner_user_id = ${ownerUserId} or ${this.inClause("w.household_id", commerceHouseholdIds)})

        union all

        -- §25 School — SchoolService.ownerOrHousehold's shape (schedule:read delegate OR active member,
        -- no visibility-column exclusion since school_events has none), status "confirmed" only, mirroring
        -- SchoolService.listSchoolEvents' own filter (a cancelled ICS event shouldn't linger on Timeline).
        select
          se.id as id,
          'school_event' as kind,
          se.title as title,
          se.start_sort as occurred_at,
          'school_event' as resource_type,
          se.id as resource_id,
          null::text as fallback_label
        from school_events se
        where se.start_sort is not null
          and se.status = 'confirmed'
          and (se.owner_user_id = ${ownerUserId} or ${this.inClause("se.household_id", scheduleHouseholdIds)})

        union all

        -- §26 Travel — TripsService.ownerOrDelegatedHousehold's shape applied to the parent trip
        -- (trip_segments.owner_user_id is denormalized from the trip, but household/deletion live on
        -- trips), plus TripsService.listTrips' own "trip" resourceGrant OR. resource_id is deliberately
        -- the TRIP id, not the segment's own id — there's no per-segment detail page, only /trips/:id, so
        -- pointing at the segment (like every other branch's resource_id) would produce a dead link;
        -- fallback_label covers a segment with no providerName sourced yet.
        select
          ts.id as id,
          'trip_segment' as kind,
          ts.provider_name as title,
          ts.start_at_sort as occurred_at,
          'trip_segment' as resource_type,
          t.id as resource_id,
          (case ts.kind
            when 'flight' then 'Flight'
            when 'lodging' then 'Lodging'
            when 'rental' then 'Car rental'
            when 'ticket' then 'Ticket'
            else 'Trip reservation'
          end) as fallback_label
        from trip_segments ts
        inner join trips t on t.id = ts.trip_id
        where ts.start_at_sort is not null
          and t.deleted_at is null
          and (
            ts.owner_user_id = ${ownerUserId}
            or ${this.inClause("t.household_id", tripsHouseholdIds)}
            or ${this.inClause("t.id", tripGrantedIds)}
          )

        union all

        -- §28 Pets (vaccinations) — PetsService.ownerOrDelegatedHousehold's shape (reuses "commerce:read",
        -- exactly like PetsService's own doc comment), plus PetsService.list's own "pet" resourceGrant OR.
        -- Only rows already assigned to a pet — an unassigned candidate (petProfileId null) is still an
        -- inbox triage item, not a confirmed fact.
        select
          pv.id as id,
          'pet_vaccination' as kind,
          pv.label as title,
          pv.expiration_date_sort as occurred_at,
          'pet_vaccination' as resource_type,
          pv.pet_profile_id as resource_id,
          null::text as fallback_label
        from pet_vaccinations pv
        where pv.expiration_date_sort is not null
          and pv.pet_profile_id is not null
          and (
            pv.owner_user_id = ${ownerUserId}
            or ${this.inClause("pv.household_id", commerceHouseholdIds)}
            or ${this.inClause("pv.pet_profile_id", petGrantedIds)}
          )

        union all

        -- §28 Pets (refill reminders) — same access shape as the vaccination branch above. refill_reminders
        -- is the shared Pets/Health-Logistics table (see its own schema doc comment); this branch is scoped
        -- to the pet side only (petProfileId set) — the human side is its own branch below with Health
        -- Logistics' deliberately stricter access rule, never this one.
        select
          rr.id as id,
          'pet_refill_reminder' as kind,
          rr.medication_name as title,
          rr.next_refill_date_sort as occurred_at,
          'pet_refill_reminder' as resource_type,
          rr.pet_profile_id as resource_id,
          null::text as fallback_label
        from refill_reminders rr
        where rr.next_refill_date_sort is not null
          and rr.pet_profile_id is not null
          and rr.deleted_at is null
          and (
            rr.owner_user_id = ${ownerUserId}
            or ${this.inClause("rr.household_id", commerceHouseholdIds)}
            or ${this.inClause("rr.pet_profile_id", petGrantedIds)}
          )

        union all

        -- §27 Health Logistics (appointments) — HealthLogisticsService.appointmentAccessCondition's shape
        -- EXACTLY: owner, OR a "health:read" delegate on a row the owner has explicitly marked
        -- visibility "household" (never plain active membership — see this class's own doc comment), OR a
        -- direct "health_appointment" resourceGrant.
        select
          ha.id as id,
          'health_appointment' as kind,
          coalesce(ha.appointment_type, ha.provider_name) as title,
          ha.date_time_sort as occurred_at,
          'health_appointment' as resource_type,
          ha.id as resource_id,
          'Health appointment' as fallback_label
        from health_appointments ha
        where ha.date_time_sort is not null
          and ha.deleted_at is null
          and (
            ha.owner_user_id = ${ownerUserId}
            or (${this.inClause("ha.household_id", healthHouseholdIds)} and ha.visibility <> 'private')
            or ${this.inClause("ha.id", healthApptGrantedIds)}
          )

        union all

        -- §27 Health Logistics (refill reminders, human side) — HealthLogisticsService.refillAccessCondition's
        -- shape exactly: owner, or a "health:read" delegate (this table has no visibility column, so
        -- delegation alone gates it here, same as that method). Never plain active membership, and never a
        -- resourceGrant — HealthLogisticsService offers no per-reminder grant mechanism.
        select
          rr2.id as id,
          'health_refill_reminder' as kind,
          rr2.medication_name as title,
          rr2.next_refill_date_sort as occurred_at,
          'health_refill_reminder' as resource_type,
          rr2.id as resource_id,
          null::text as fallback_label
        from refill_reminders rr2
        where rr2.next_refill_date_sort is not null
          and rr2.pet_profile_id is null
          and rr2.deleted_at is null
          and (rr2.owner_user_id = ${ownerUserId} or ${this.inClause("rr2.household_id", healthHouseholdIds)})
      ) timeline
      where ${beforeTimestamp}::timestamptz is null or occurred_at < ${beforeTimestamp}
      order by occurred_at desc
      limit ${PAGE_SIZE + 1}
    `);

    const rows = result.rows;
    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

    // Raw sql`...` bypasses Drizzle's customType decode, so every encrypted title column (calendar_events.title,
    // tasks.title, bills.biller_label, warranties.product_label, documents.title, school_events.title, trip_segments.
    // provider_name, pet_vaccinations.label, refill_reminders.medication_name, and health_appointments'
    // appointment_type/provider_name) come back as ciphertext here and need manual decryption. purchases'
    // title (merchant name / order number) and return_cases' literal "Return deadline" are never encrypted,
    // so those pass through unchanged. Unlike the original six, several of the new branches can legitimately
    // have a null encrypted title (trip_segments.provider_name, health_appointments' both source fields) —
    // `fallback_label` (a plain, never-encrypted column, null on every branch that can't produce a null
    // title) covers that case instead of calling decryptField(null), which throws.
    const ENCRYPTED_TITLE_KINDS = new Set([
      "calendar_event",
      "task",
      "bill",
      "document",
      "warranty",
      "school_event",
      "trip_segment",
      "pet_vaccination",
      "pet_refill_reminder",
      "health_appointment",
      "health_refill_reminder",
    ]);
    const items: TimelineItem[] = page.map((row) => ({
      id: row.id,
      kind: row.kind as TimelineItem["kind"],
      title: ENCRYPTED_TITLE_KINDS.has(row.kind) ? (row.title ? decryptField(row.title) : (row.fallback_label ?? "Untitled")) : (row.title ?? ""),
      occurredAt: new Date(row.occurred_at).toISOString(),
      resourceType: row.resource_type,
      resourceId: row.resource_id,
    }));

    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.occurredAt : null };
  }
}
