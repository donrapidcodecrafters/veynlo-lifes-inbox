import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  generateId,
  expandOccurrences,
  nextMileageDue,
  ruleIsMileageBased,
  nextMileageOrCalendarDue,
  nextMileageOrCalendarCalendarDate,
  ruleIsMileageOrCalendarBased,
  type TemporalValue,
  type RecurrenceRule,
  type MileageDueStatus,
  type MileageOrCalendarDueStatus,
} from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { ConflictService } from "./conflict.service";
import { householdAdultBusyIntervals as computeHouseholdAdultBusyIntervals } from "./adult-availability";
import { AssetsService } from "../assets/assets.service";
import { SearchIndexService } from "../search/search-index.service";
import { defaultReminderMinutes } from "../ingestion/temporal.util";
import type { CreateTaskDto, CreateEventDto } from "./dto";

// TASK-003 — how many future occurrences of a recurring task/event to show as a preview alongside the row
// itself, and how far ahead to look for them. Deliberately small: this is "here's the pattern" context for
// the UI, not a full recurring-series calendar view (which would need its own paginated endpoint).
const OCCURRENCE_PREVIEW_COUNT = 5; // the row's own occurrence + up to 4 more
const OCCURRENCE_PREVIEW_WINDOW_DAYS = 365;

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  return isoDateOnly(new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000));
}

/** The calendar date a TemporalValue anchors a recurrence rule to — only "date" and "instant" precision are
 * usable (never fabricate an anchor from an approximate/month/unknown value). */
function anchorDateOf(value: TemporalValue | null): string | null {
  if (!value) return null;
  if (value.precision === "date" && value.date) return value.date;
  if (value.precision === "instant" && value.instantUtc) return value.instantUtc.slice(0, 10);
  return null;
}

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(NotificationDeliveryService) private readonly notifications: NotificationDeliveryService,
    @Inject(ConflictService) private readonly conflicts: ConflictService,
    @Inject(AssetsService) private readonly assets: AssetsService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional
    // `new ScheduleService(...)` test construction keeps compiling unchanged.
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  /**
   * VEH-007 "every 5,000 miles" mileage-based recurrence — the mileage-rule counterpart to
   * previewOccurrences above, evaluated against the referenced vehicle's real odometer history rather than
   * calendar dates (see recurrence.ts's own doc comment on why `expandOccurrences` itself rejects this
   * rule kind). `rule.baselineMileage` being null means "count from the vehicle's earliest known odometer
   * observation" (see the schema field's own doc comment) — resolved here, the one DB lookup
   * `nextMileageDue` itself deliberately can't do.
   */
  private async mileageStatusFor(rule: Extract<RecurrenceRule, { kind: "mileage" }>): Promise<MileageDueStatus> {
    const [baseline, current] = await Promise.all([
      rule.baselineMileage != null ? Promise.resolve(rule.baselineMileage) : this.assets.earliestOdometerMileage(rule.vehicleProfileId),
      this.assets.latestOdometerMileage(rule.vehicleProfileId),
    ]);
    return nextMileageDue(rule, baseline ?? 0, current);
  }

  /**
   * VEH-003 "mileage_or_calendar" composite rule — the same DB-resolution `mileageStatusFor` above does
   * for a plain "mileage" rule, plus resolving the calendar anchor date (the row's own `dueCondition`,
   * same as every non-mileage rule kind uses — see `anchorDateOf`). Returns null when the row has no
   * resolvable due date to anchor the calendar side to at all (mirrors `previewOccurrences`'s own
   * `if (!anchorDate) return []` guard) — a composite rule genuinely needs both sides to mean anything.
   */
  private async mileageOrCalendarStatusFor(rule: Extract<RecurrenceRule, { kind: "mileage_or_calendar" }>, anchorValue: TemporalValue | null): Promise<MileageOrCalendarDueStatus | null> {
    const anchorDate = anchorDateOf(anchorValue);
    if (!anchorDate) return null;
    const [baseline, current] = await Promise.all([
      rule.baselineMileage != null ? Promise.resolve(rule.baselineMileage) : this.assets.earliestOdometerMileage(rule.vehicleProfileId),
      this.assets.latestOdometerMileage(rule.vehicleProfileId),
    ]);
    return nextMileageOrCalendarDue(rule, anchorDate, baseline ?? 0, current, isoDateOnly(new Date()));
  }

  /**
   * TASK-003 occurrence expansion — computed on read, not materialized as rows. This codebase has no
   * job-scheduling infrastructure (grepped for "cron"/"@nestjs/schedule"/"ScheduleModule" — genuinely
   * nothing exists), so a nightly-materialization job would mean standing up an entire new piece of
   * infrastructure just for this feature. Computing occurrences at read time is simpler, always correct
   * relative to whatever the rule currently says (a materialized-row approach risks stale rows if the rule
   * is edited after tomorrow's occurrences were already written), and cheap at this app's scale (one
   * person's/household's own events and tasks, not a multi-tenant scheduling system).
   *
   * Rather than multiplying each recurring row into several synthetic "occurrence rows" with fabricated
   * ids (which would need its own identity/action-routing scheme — is completing occurrence #3 of a
   * recurring task even a coherent action without per-occurrence completion state, which nothing here
   * tracks?), this returns the row's own date/time unchanged and attaches a `nextOccurrences` preview list
   * (plain ISO dates) alongside it. The row stays the single source of truth for anything actionable
   * (complete/accept/decline); the preview is purely informational ("this repeats — also on these dates").
   */
  private async previewOccurrences(rule: RecurrenceRule, anchorValue: TemporalValue | null): Promise<string[]> {
    // Defensive, not just for tasks(): tasks() itself always special-cases "mileage"/"mileage_or_calendar"
    // BEFORE ever calling this method (see its own branches above), so this guard only matters for
    // upcomingEvents(), which has no such pre-check and would otherwise crash on `expandOccurrences`'s own
    // guard for either kind — nothing in the UI offers either kind for an *event* (RecurrencePicker's
    // vehicle-maintenance option is task-only, see apps/web's recurrence-picker.tsx), but the DTO layer
    // doesn't structurally prevent one being set via a direct API call, so failing soft here (no preview,
    // same as an unresolvable days_before anchor) beats a 500.
    if (rule.kind === "mileage" || rule.kind === "mileage_or_calendar") return [];
    if (rule.kind === "days_before") {
      // "days_before" doesn't produce a *series* the way daily/weekly/etc. do — it's a single date computed
      // relative to one other row (see recurrence.ts's own doc comment), so there's no "next few
      // occurrences" to preview. The only thing worth surfacing here is when the external anchor has moved
      // since this row's own date was last set (e.g. the referenced event got rescheduled) — show the
      // freshly recomputed date as a one-item "this may need updating" preview, nothing otherwise.
      const externalAnchorDate = await this.resolveDaysBeforeAnchorDate(rule);
      if (!externalAnchorDate) return []; // anchor entity missing/undated — see resolveDaysBeforeAnchorDate's own comment
      const [computed] = expandOccurrences(rule, externalAnchorDate, { from: externalAnchorDate, count: 1 });
      const current = anchorDateOf(anchorValue);
      return computed && computed !== current ? [computed] : [];
    }
    const anchorDate = anchorDateOf(anchorValue);
    if (!anchorDate) return [];
    const to = addDaysIso(anchorDate, OCCURRENCE_PREVIEW_WINDOW_DAYS);
    const dates = expandOccurrences(rule, anchorDate, { from: anchorDate, to, count: OCCURRENCE_PREVIEW_COUNT });
    return dates.slice(1); // drop the first — that's the row's own stored occurrence, not a "next" one
  }

  /** "days_before" rules anchor to a *different* row's date (e.g. "3 days before this vehicle
   * registration-renewal event"). Resolving that requires a DB lookup this codebase's pure
   * `expandOccurrences` deliberately doesn't do itself. Best-effort: if the referenced row is gone, has no
   * resolvable date, or (defensively) belongs to a different owner than whoever set up the rule, this
   * returns null and the caller simply shows no preview rather than guessing — the stored row's own date is
   * still shown regardless, so nothing about the task/event itself is ever hidden by this failing. */
  private async resolveDaysBeforeAnchorDate(rule: Extract<RecurrenceRule, { kind: "days_before" }>): Promise<string | null> {
    if (rule.anchorEntity.type === "calendar_event") {
      const [row] = await this.db.select({ start: schema.calendarEvents.start }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, rule.anchorEntity.id)).limit(1);
      return row ? anchorDateOf(row.start) : null;
    }
    const [row] = await this.db.select({ dueCondition: schema.tasks.dueCondition }).from(schema.tasks).where(eq(schema.tasks.id, rule.anchorEntity.id)).limit(1);
    return row ? anchorDateOf(row.dueCondition) : null;
  }

  /**
   * FAM-006 enforcement, mirroring CommerceService.ownerOrDelegatedHousehold. Unlike commerce, a
   * delegated household's rows additionally exclude `visibility: "private"` when a visibility column is
   * given (calendar_events only — tasks has none) so a member's explicitly private event doesn't leak to
   * a caregiver just because they hold a household-wide grant; the owner's own rows are never filtered by
   * visibility.
   *
   * Also OR's in plain active membership alongside delegation (see HouseholdService.activeHouseholdIds's
   * own doc comment) — delegation alone meant a household-shared, unassigned task or event never showed
   * up for an ordinary member (only for the creator, or an explicitly delegated caregiver), confirmed live
   * on the Life screen's Appointments/Reminders sections.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn, visibilityCol?: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "schedule:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    if (householdIds.length === 0) return eq(ownerCol, userId);
    const householdCondition = visibilityCol ? and(inArray(householdCol, householdIds), ne(visibilityCol, "private"))! : inArray(householdCol, householdIds);
    return or(eq(ownerCol, userId), householdCondition)!;
  }

  /**
   * CAL-001 "duplicate copies visually collapse while preserving original records" — display-layer
   * grouping only (see IngestionService.findCrossSourceCalendarEventMatch for where the actual `linkedEventId`
   * gets set at write time). Neither row is ever deleted or merged; this only decides which ONE card a
   * cross-source-linked pair renders as in a list, attaching the other row(s) as `linkedEvents` so the UI
   * can show a "N sources" disclosure. `leaderId = linkedEventId ?? id` gives every member of a group the
   * same grouping key regardless of which member a caller is looking at; the card itself is built from
   * whichever member appears FIRST in the already-startSort-ordered `events` array (typically the earlier-
   * occurring, but ties resolve to insertion order), not necessarily the "leader" row `linkedEventId`
   * points at — there's no meaningful difference in which of the two real records is shown as primary.
   */
  private groupLinkedCalendarEvents<T extends { id: string; linkedEventId: string | null }>(
    events: T[],
    extraLeaders: T[] = [],
  ): Array<T & { linkedEvents: T[] }> {
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const leader of extraLeaders) if (!byId.has(leader.id)) byId.set(leader.id, leader);

    const groups = new Map<string, T[]>();
    for (const e of events) {
      const leaderId = e.linkedEventId ?? e.id;
      if (!groups.has(leaderId)) groups.set(leaderId, []);
      groups.get(leaderId)!.push(e);
    }

    const seenLeader = new Set<string>();
    const result: Array<T & { linkedEvents: T[] }> = [];
    for (const e of events) {
      const leaderId = e.linkedEventId ?? e.id;
      if (seenLeader.has(leaderId)) continue; // this group's card was already emitted at an earlier position
      seenLeader.add(leaderId);
      const members = groups.get(leaderId) ?? [];
      // The leader row itself may have fallen out of the fetched set entirely (e.g. `upcomingEvents`'s own
      // `startSort >= now` filter, when the earlier-created record's start time has already passed while its
      // linked duplicate's hasn't) — `extraLeaders` lets the caller backfill it so the "N sources" count and
      // disclosure are still complete even across that boundary.
      const leaderRow = byId.get(leaderId);
      const allMembers = leaderRow && !members.some((m) => m.id === leaderRow.id) ? [leaderRow, ...members] : members;
      result.push({ ...e, linkedEvents: allMembers.filter((m) => m.id !== e.id) });
    }
    return result;
  }

  async upcomingEvents(userId: string) {
    const events = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          await this.ownerOrDelegatedHousehold(userId, schema.calendarEvents.ownerUserId, schema.calendarEvents.householdId, schema.calendarEvents.visibility),
          gte(schema.calendarEvents.startSort, new Date()),
        ),
      )
      .orderBy(asc(schema.calendarEvents.startSort));

    const missingLeaderIds = [...new Set(events.map((e) => e.linkedEventId).filter((id): id is string => !!id && !events.some((e2) => e2.id === id)))];
    const extraLeaders = missingLeaderIds.length > 0 ? await this.db.select().from(schema.calendarEvents).where(inArray(schema.calendarEvents.id, missingLeaderIds)) : [];

    const grouped = this.groupLinkedCalendarEvents(events, extraLeaders);
    return Promise.all(
      grouped.map(async ({ linkedEvents, ...event }) => ({
        ...event,
        nextOccurrences: event.recurrenceRule ? await this.previewOccurrences(event.recurrenceRule, event.start) : [],
        // Deliberately a lean projection (no per-member evidence/provider-name lookup here — that's an
        // N+1 join this list endpoint shouldn't pay for on every single row). `providerEventId != null`
        // is enough for the list card's own "N sources" badge to label each member "Synced calendar" vs
        // "Discovered from email"; a click-through to that member's own `eventDetail` resolves the exact
        // provider name via the existing evidence join.
        linkedEvents: linkedEvents.map((m) => ({
          id: m.id,
          title: m.title,
          start: m.start,
          isAllDay: m.isAllDay,
          location: m.location,
          source: m.source,
          providerEventId: m.providerEventId,
          status: m.status,
        })),
      })),
    );
  }

  /** Same indirect evidence-resolution pattern as CommerceService (calendar_events has no direct sourceEventId column — traced via the inbox_items row that filed it). Kept local rather than shared to avoid coupling two otherwise-independent services over a few lines of logic. */
  private async evidenceForSourceEvent(sourceEventId: string | null) {
    if (!sourceEventId) return null;
    const [row] = await this.db
      .select({ event: schema.sourceEvents, connection: schema.connections })
      .from(schema.sourceEvents)
      .leftJoin(schema.connections, eq(schema.connections.id, schema.sourceEvents.connectionId))
      .where(eq(schema.sourceEvents.id, sourceEventId))
      .limit(1);
    if (!row) return null;
    return {
      sourceEventId: row.event.id,
      kind: row.event.kind,
      subjectLine: row.event.subjectLine,
      snippet: row.event.snippet,
      fromAddress: row.event.fromAddress,
      occurredAt: row.event.occurredAt,
      provider: row.connection?.provider ?? null,
    };
  }

  private async evidenceViaInboxItem(linkedResourceType: string, linkedResourceId: string) {
    const [inboxItem] = await this.db
      .select({ sourceEventId: schema.inboxItems.sourceEventId })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.linkedResourceType, linkedResourceType), eq(schema.inboxItems.linkedResourceId, linkedResourceId)))
      .limit(1);
    return this.evidenceForSourceEvent(inboxItem?.sourceEventId ?? null);
  }

  async eventDetail(eventId: string, userId: string) {
    const [event] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event) return null;
    if (event.ownerUserId !== userId) {
      // Same membership-or-delegation visibility as ownerOrDelegatedHousehold above — a plain household
      // member needs to be able to open a shared event's detail page too, not just a delegated caregiver.
      const householdIds = event.householdId
        ? [...(await this.households.delegatedHouseholdIds(userId, "schedule:read")), ...(await this.households.activeHouseholdIds(userId))]
        : [];
      if (!event.householdId || !householdIds.includes(event.householdId) || event.visibility === "private") return null;
    }
    return {
      event,
      evidence: await this.evidenceViaInboxItem("calendar_event", eventId),
      // CAL-001 — the other record(s) this event has been cross-source-linked with (see
      // IngestionService.findCrossSourceCalendarEventMatch): whichever event this one's own `linkedEventId`
      // points AT, plus any other event that points AT this one. Both directions are checked since a caller
      // can open either member of a linked pair's own detail page, not just the one whose row happens to
      // carry `linkedEventId`. Each member's own evidence is resolved too (unlike `upcomingEvents`'s lean
      // list projection) since a detail page is a single-row fetch, not a list — this join here is cheap.
      linkedEvents: await Promise.all(
        (await this.linkedCalendarEventGroup(event)).map(async (linked) => ({
          event: linked,
          evidence: await this.evidenceViaInboxItem("calendar_event", linked.id),
        })),
      ),
    };
  }

  private async linkedCalendarEventGroup(event: typeof schema.calendarEvents.$inferSelect) {
    const pointingAtMe = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.linkedEventId, event.id));
    const results = [...pointingAtMe];
    if (event.linkedEventId) {
      const [leader] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, event.linkedEventId)).limit(1);
      if (leader) results.push(leader);
    }
    return results;
  }

  /**
   * Phase 2 §52.2 "assignments" — a task assigned to a household member must be visible to them even
   * without a caregiver delegation grant (delegation is for viewing SOMEONE ELSE's whole schedule; being
   * the assignee of one specific task is a narrower, always-granted relationship to that one row).
   */
  async tasks(userId: string) {
    const rows = await this.db
      .select()
      .from(schema.tasks)
      .where(or(await this.ownerOrDelegatedHousehold(userId, schema.tasks.ownerUserId, schema.tasks.householdId), eq(schema.tasks.assignedToUserId, userId))!)
      .orderBy(asc(schema.tasks.dueSort));
    return Promise.all(
      rows.map(async (task) => {
        // VEH-007 "mileage" rules have no calendar-date preview at all (see expandOccurrences's own
        // guard) — they get a `mileageStatus` instead of `nextOccurrences`, computed against the
        // referenced vehicle's real odometer history.
        if (task.recurrenceRule && ruleIsMileageBased(task.recurrenceRule)) {
          return { ...task, nextOccurrences: [] as string[], mileageStatus: await this.mileageStatusFor(task.recurrenceRule), mileageOrCalendarStatus: null as MileageOrCalendarDueStatus | null };
        }
        // VEH-003 "mileage_or_calendar" — same "no calendar-date preview" shape as the mileage-only branch
        // above (expandOccurrences rejects this kind too), but with its own combined status field rather
        // than reusing `mileageStatus`, since a composite rule's status includes a calendar side
        // `MileageDueStatus` alone can't represent.
        if (task.recurrenceRule && ruleIsMileageOrCalendarBased(task.recurrenceRule)) {
          return { ...task, nextOccurrences: [] as string[], mileageStatus: null as MileageDueStatus | null, mileageOrCalendarStatus: await this.mileageOrCalendarStatusFor(task.recurrenceRule, task.dueCondition) };
        }
        return {
          ...task,
          nextOccurrences: task.recurrenceRule ? await this.previewOccurrences(task.recurrenceRule, task.dueCondition) : [],
          mileageStatus: null as MileageDueStatus | null,
          mileageOrCalendarStatus: null as MileageOrCalendarDueStatus | null,
        };
      }),
    );
  }

  /**
   * The assignee can complete their own assigned task even though the owner (whoever created it) still
   * "owns" the row — same reasoning as tasks() including assigned rows regardless of delegation.
   *
   * Found live during a requirements re-audit: an UNASSIGNED household task (e.g. a recurring chore
   * nobody's claimed) is visible to every household member via `tasks()`'s `ownerOrDelegatedHousehold`
   * branch, but this used to allow only the owner or assignee to complete it — any other member who could
   * see the chore and actually did it had no way to check it off, only the original creator could. A task
   * assigned to a SPECIFIC other member is left alone (still owner-or-assignee-only): letting an unrelated
   * household member mark someone else's named assignment "done" on their behalf is a materially different
   * action than checking off a shared, unclaimed chore, and isn't what this fix is for.
   *
   * TASK-003 recurrence decision: completing a *recurring* task rolls its due date forward to the rule's
   * next occurrence and leaves it open, instead of marking the whole series "completed" forever — matches
   * how every mainstream reminders app treats a repeating chore ("take out the trash" recurring weekly
   * isn't "done forever" after one week). Since occurrences aren't materialized as separate rows (see
   * `previewOccurrences`'s doc comment), there's no per-occurrence completion history — only "the series'
   * current due date," which this advances. A rule that can't produce a further occurrence (its external
   * `days_before` anchor is gone, or is otherwise unresolvable) falls back to ordinary one-time completion.
   *
   * VEH-007 "mileage" rules roll forward the same way, but re-anchor `baselineMileage` to the vehicle's
   * CURRENT odometer reading (not "current + intervalMiles" — the next due point is computed fresh from
   * wherever the vehicle actually is right now) rather than computing a next calendar date. If the vehicle
   * has no odometer reading at all yet, there's nothing to re-anchor to, so this falls back to ordinary
   * one-time completion exactly like an unresolvable `days_before` anchor does above.
   */
  async completeTask(id: string, userId: string): Promise<void> {
    const [task] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    if (!task) throw new NotFoundException({ code: "TASK_NOT_FOUND", message: "Task not found." });
    if (task.ownerUserId !== userId && task.assignedToUserId !== userId) {
      const canCompleteUnassignedHouseholdTask = task.assignedToUserId === null && task.householdId !== null && (await this.households.isActiveMember(task.householdId, userId));
      if (!canCompleteUnassignedHouseholdTask) {
        throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this task." });
      }
    }
    if (task.recurrenceRule && ruleIsMileageBased(task.recurrenceRule)) {
      const current = await this.assets.latestOdometerMileage(task.recurrenceRule.vehicleProfileId);
      if (current != null) {
        const recurrenceRule: RecurrenceRule = { ...task.recurrenceRule, baselineMileage: current };
        await this.db.update(schema.tasks).set({ recurrenceRule, updatedAt: new Date() }).where(eq(schema.tasks.id, id));
        return;
      }
      // No odometer reading yet — fall through to ordinary one-time completion below, same as an
      // unresolvable days_before anchor.
    } else if (task.recurrenceRule && ruleIsMileageOrCalendarBased(task.recurrenceRule)) {
      // VEH-003 "whichever comes first" — completing the task re-anchors BOTH sides to "now": the calendar
      // due date advances `intervalMonths` from the row's current due date (same clamped arithmetic
      // `previewOccurrences` uses for a plain monthly rule), and baselineMileage re-anchors to the
      // vehicle's current reading, exactly like the mileage-only branch above. This deliberately does NOT
      // try to preserve "how much mileage/time was left over" from whichever side triggered completion —
      // same "never compensate for overrun, always exactly one interval past wherever things stand now"
      // philosophy nextMileageDue's own doc comment states for the mileage-only case. Needs BOTH a current
      // odometer reading and a resolvable existing due date to advance; missing either falls through to
      // ordinary one-time completion, same as the mileage-only/days_before fallback cases above.
      const current = await this.assets.latestOdometerMileage(task.recurrenceRule.vehicleProfileId);
      const anchorDate = anchorDateOf(task.dueCondition);
      if (current != null && anchorDate) {
        const nextDate = nextMileageOrCalendarCalendarDate(task.recurrenceRule, anchorDate);
        const recurrenceRule: RecurrenceRule = { ...task.recurrenceRule, baselineMileage: current };
        const dueCondition: TemporalValue = { precision: "date", instantUtc: null, date: nextDate, timezone: null, sourceText: null };
        await this.db
          .update(schema.tasks)
          .set({ recurrenceRule, dueCondition, dueSort: new Date(`${nextDate}T00:00:00Z`), updatedAt: new Date() })
          .where(eq(schema.tasks.id, id));
        return;
      }
      // Missing odometer reading or due date — fall through to ordinary one-time completion below.
    } else if (task.recurrenceRule) {
      const next = await this.nextOccurrenceAfter(task.recurrenceRule, task.dueCondition);
      if (next) {
        const dueCondition: TemporalValue = { precision: "date", instantUtc: null, date: next, timezone: null, sourceText: null };
        await this.db
          .update(schema.tasks)
          .set({ dueCondition, dueSort: new Date(`${next}T00:00:00Z`), updatedAt: new Date() })
          .where(eq(schema.tasks.id, id));
        return;
      }
    }
    await this.db.update(schema.tasks).set({ state: "completed", updatedAt: new Date() }).where(eq(schema.tasks.id, id));
  }

  /** The single next occurrence strictly after the row's own current date — used to roll a completed recurring task's due date forward. */
  private async nextOccurrenceAfter(rule: RecurrenceRule, currentValue: TemporalValue | null): Promise<string | null> {
    if (rule.kind === "days_before") {
      const externalAnchorDate = await this.resolveDaysBeforeAnchorDate(rule);
      if (!externalAnchorDate) return null;
      const [only] = expandOccurrences(rule, externalAnchorDate, { from: externalAnchorDate, count: 1 });
      const current = anchorDateOf(currentValue);
      return only && only !== current ? only : null;
    }
    const anchorDate = anchorDateOf(currentValue);
    if (!anchorDate) return null;
    const dayAfter = addDaysIso(anchorDate, 1);
    const to = addDaysIso(anchorDate, OCCURRENCE_PREVIEW_WINDOW_DAYS);
    const [next] = expandOccurrences(rule, anchorDate, { from: dayAfter, to, count: 1 });
    return next ?? null;
  }

  /** Manual task creation — previously every task came only from AI extraction or a device-reminders sync; there was no way for a user to just add one directly, which "assignments" needs as a starting point (you can't assign a task that doesn't exist yet). */
  async createTask(userId: string, dto: CreateTaskDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    if (dto.assignedToUserId && dto.assignedToUserId !== userId) {
      if (!dto.householdId) throw new ForbiddenException({ code: "HOUSEHOLD_REQUIRED", message: "Assigning a task to someone else requires a household." });
      const assigneeIsMember = await this.households.isActiveMember(dto.householdId, dto.assignedToUserId);
      if (!assigneeIsMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "That person isn't an active member of this household." });
    }
    const dueCondition: TemporalValue | null = dto.dueIso ? { precision: "date", instantUtc: null, date: dto.dueIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const id = generateId("task");
    const assignedToSomeoneElse = Boolean(dto.assignedToUserId && dto.assignedToUserId !== userId);
    await this.db.insert(schema.tasks).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      assignedToUserId: dto.assignedToUserId ?? null,
      assignmentStatus: assignedToSomeoneElse ? "pending" : dto.assignedToUserId ? "accepted" : "unassigned",
      assignmentNotes: dto.assignmentNotes ?? null,
      title: dto.title,
      dueCondition,
      dueSort: dueCondition?.date ? new Date(`${dueCondition.date}T00:00:00Z`) : null,
      priority: dto.priority ?? "medium",
      recurrenceRule: dto.recurrenceRule ?? null,
    });
    if (assignedToSomeoneElse) {
      await this.notifyAssignment(dto.assignedToUserId!, id, dto.title);
    }
    return { id };
  }

  /** TASK-003 — lets an existing task's recurrence rule be set/changed/cleared after creation, without a full generic task-edit endpoint (none exists yet — see this module's other granular action endpoints, e.g. assign/accept/decline, for the same narrow-endpoint style). Owner-only, mirroring assignTask. */
  async setTaskRecurrence(id: string, userId: string, recurrenceRule: RecurrenceRule | null): Promise<void> {
    const [task] = await this.db.select({ ownerUserId: schema.tasks.ownerUserId }).from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    if (!task) throw new NotFoundException({ code: "TASK_NOT_FOUND", message: "Task not found." });
    if (task.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the task's owner can change its recurrence." });
    await this.db.update(schema.tasks).set({ recurrenceRule, updatedAt: new Date() }).where(eq(schema.tasks.id, id));
  }

  /** FAM-003 "Assignment has acceptance/decline/complete... and notification policy" — the one place both
   * createTask and assignTask notify a new assignee, so the wording/dedupe key stay consistent. */
  private async notifyAssignment(assigneeUserId: string, taskId: string, title: string): Promise<void> {
    await this.notifications.createAndEnqueue({
      ownerUserId: assigneeUserId,
      dedupeKey: `task-assigned:${taskId}`,
      priority: "useful",
      title: "You've been assigned a task",
      body: `"${title}" — accept or decline it in Veynlo.`,
    });
  }

  /**
   * Phase 2 §52.2 "tasks/reminders integrations" — the sync counterpart to `createTask`, called by
   * `GoogleTasksAdapter`/`MicrosoftToDoAdapter` instead of the user directly. Dedup is keyed on
   * `(externalSyncProvider, externalSyncId)`, the pair `tasks` reserved these two columns for from the
   * start rather than a new table — a re-sync of the same provider task updates the existing row (title,
   * due date, completion) instead of creating a duplicate.
   */
  async upsertExternalTask(params: {
    ownerUserId: string;
    householdId: string | null;
    provider: string;
    externalId: string;
    title: string;
    dueDate: string | null;
    completed: boolean;
  }): Promise<{ created: boolean }> {
    const dueCondition: TemporalValue | null = params.dueDate
      ? { precision: "date", instantUtc: null, date: params.dueDate, timezone: null, sourceText: null }
      : null;
    const dueSort = dueCondition?.date ? new Date(`${dueCondition.date}T00:00:00Z`) : null;

    // Scoped by ownerUserId too, not just (provider, externalId) — those two alone aren't guaranteed
    // globally unique across every Veynlo account (e.g. the same underlying Google/Microsoft account
    // connected under two different Veynlo logins, or a shared To Do list). Without the owner scope, the
    // update branch below would silently overwrite whichever user's task row happened to already exist
    // with another user's title/due-date/completion state — cross-tenant data corruption. Mirrors
    // IngestionService.ingestDeviceReminder's identical (owner-scoped) lookup for the same reason.
    const [existing] = await this.db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.ownerUserId, params.ownerUserId),
          eq(schema.tasks.externalSyncProvider, params.provider),
          eq(schema.tasks.externalSyncId, params.externalId),
        ),
      )
      .limit(1);

    if (existing) {
      await this.db
        .update(schema.tasks)
        .set({ title: params.title, dueCondition, dueSort, state: params.completed ? "completed" : "open", updatedAt: new Date() })
        .where(eq(schema.tasks.id, existing.id));
      return { created: false };
    }

    await this.db.insert(schema.tasks).values({
      id: generateId("task"),
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      title: params.title,
      dueCondition,
      dueSort,
      state: params.completed ? "completed" : "open",
      externalSyncProvider: params.provider,
      externalSyncId: params.externalId,
    });
    return { created: true };
  }

  /** Reassigns an existing task — owner-only (mirrors completeTask's ownership stance: the assignee can act ON the task, but only the owner controls WHO it's assigned to). Every new assignment resets to "pending" — a fresh acceptance/decline decision, even if the previous assignee had already accepted or declined it. */
  async assignTask(id: string, requestingUserId: string, assignedToUserId: string | null, assignmentNotes?: string | null): Promise<void> {
    const [task] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    if (!task) throw new NotFoundException({ code: "TASK_NOT_FOUND", message: "Task not found." });
    if (task.ownerUserId !== requestingUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the task's owner can reassign it." });
    if (assignedToUserId && assignedToUserId !== task.ownerUserId) {
      if (!task.householdId) throw new ForbiddenException({ code: "HOUSEHOLD_REQUIRED", message: "Assigning this task to someone else requires a household." });
      const isMember = await this.households.isActiveMember(task.householdId, assignedToUserId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "That person isn't an active member of this household." });
    }
    const assignedToSomeoneElse = Boolean(assignedToUserId && assignedToUserId !== requestingUserId);
    await this.db
      .update(schema.tasks)
      .set({
        assignedToUserId,
        assignmentStatus: assignedToSomeoneElse ? "pending" : assignedToUserId ? "accepted" : "unassigned",
        assignmentNotes: assignmentNotes ?? null,
        updatedAt: new Date(),
      })
      .where(eq(schema.tasks.id, id));
    if (assignedToSomeoneElse) {
      await this.notifyAssignment(assignedToUserId!, id, task.title);
    }
  }

  /** FAM-003 "acceptance/decline" — assignee-only, and only while the assignment is still pending a
   * decision (re-running accept/decline after the owner has already reassigned to someone else, or after
   * the assignee already decided, is a stale action on the client's part, not a valid transition). */
  private async ownedPendingAssignment(taskId: string, assigneeUserId: string) {
    const [task] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    if (!task) throw new NotFoundException({ code: "TASK_NOT_FOUND", message: "Task not found." });
    if (task.assignedToUserId !== assigneeUserId) throw new ForbiddenException({ code: "NOT_ASSIGNEE", message: "This task isn't assigned to you." });
    if (task.assignmentStatus !== "pending") {
      throw new ForbiddenException({ code: "ASSIGNMENT_NOT_PENDING", message: "This assignment isn't waiting on a decision anymore." });
    }
    return task;
  }

  async acceptAssignment(taskId: string, assigneeUserId: string): Promise<void> {
    await this.ownedPendingAssignment(taskId, assigneeUserId);
    await this.db.update(schema.tasks).set({ assignmentStatus: "accepted", updatedAt: new Date() }).where(eq(schema.tasks.id, taskId));
  }

  async declineAssignment(taskId: string, assigneeUserId: string): Promise<void> {
    const task = await this.ownedPendingAssignment(taskId, assigneeUserId);
    await this.db.update(schema.tasks).set({ assignmentStatus: "declined", updatedAt: new Date() }).where(eq(schema.tasks.id, taskId));
    // Spec's own failure/edge-state list calls out "no one accepts assignment" explicitly — the owner
    // needs to actually find out, not just have the row sit declined and unnoticed.
    await this.notifications.createAndEnqueue({
      ownerUserId: task.ownerUserId,
      dedupeKey: `task-declined:${taskId}`,
      priority: "useful",
      title: "An assignment was declined",
      body: `"${task.title}" was declined — reassign it or take it back yourself.`,
    });
  }

  /**
   * Manual event creation — previously every calendar_events row came only from AI discovery or a
   * provider sync (see CreateEventDtoSchema's own doc comment). Runs CAL-003's synchronous conflict check
   * immediately after inserting, per spec's "detected... whenever a new/edited event is saved," and
   * returns whatever conflicts that turns up so the UI can show them right away instead of only on next
   * page load.
   */
  /**
   * `source` defaults to "manual" for the public API surface (ScheduleController never passes it — a
   * user-created event is always "manual") but is overridable for internal callers that need conflict
   * detection without losing their own provenance label. AutomationService.executeRun's `add_calendar_event`
   * action is the first such caller (see its own doc comment): it used to insert directly into
   * `calendar_events`, bypassing this method entirely and, with it, CAL-003 conflict detection — routing
   * through here fixes that while still tagging the row `source: "automation"`, exactly as before.
   */
  async createEvent(
    userId: string,
    dto: CreateEventDto,
    source: string = "manual",
  ): Promise<{ id: string; conflicts: Array<typeof schema.scheduleConflicts.$inferSelect> }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    const start: TemporalValue = dto.isAllDay
      ? { precision: "date", instantUtc: null, date: dto.startIso.slice(0, 10), timezone: null, sourceText: null }
      : { precision: "instant", instantUtc: new Date(dto.startIso).toISOString(), date: null, timezone: null, sourceText: null };
    const end: TemporalValue | null = dto.endIso
      ? dto.isAllDay
        ? { precision: "date", instantUtc: null, date: dto.endIso.slice(0, 10), timezone: null, sourceText: null }
        : { precision: "instant", instantUtc: new Date(dto.endIso).toISOString(), date: null, timezone: null, sourceText: null }
      : null;
    const startSort = dto.isAllDay ? new Date(`${start.date}T00:00:00Z`) : new Date(start.instantUtc!);

    // CAL-003 "double-booked shared assets" — a vehicle can only be tagged if this user can actually access
    // it (their own, or shared into a household they belong to/are delegated into — `vehicleDetail` throws
    // ForbiddenException itself on a real access denial, and returns null for a not-found/deleted vehicle).
    if (dto.vehicleProfileId) {
      const vehicle = await this.assets.vehicleDetail(dto.vehicleProfileId, userId);
      if (!vehicle) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    }

    const id = generateId("calendarEvent");
    await this.db.insert(schema.calendarEvents).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      title: dto.title,
      start,
      startSort,
      end,
      isAllDay: dto.isAllDay ?? false,
      location: dto.location ?? null,
      source,
      status: "confirmed",
      visibility: dto.visibility ?? "private",
      recurrenceRule: dto.recurrenceRule ?? null,
      relatedEntityIds: dto.vehicleProfileId ? [dto.vehicleProfileId] : [],
      reminderMinutesBefore: dto.reminderMinutesBefore ?? defaultReminderMinutes(dto.isAllDay ?? false),
    });
    await this.searchIndex?.upsert({
      resourceType: "calendar_event",
      resourceId: id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      sensitivity: "sensitive",
      title: dto.title,
      bodyText: dto.location ?? "",
    });

    const overlapConflicts = await this.conflicts.detectOverlaps(id, userId);
    // Only worth a second query/scan when a vehicle was actually tagged — the common (no-vehicle) case
    // skips it entirely rather than relying on vehicleConflicts' own early-return on an empty tag.
    const vehicleConflicts = dto.vehicleProfileId ? await this.conflicts.vehicleConflicts(id) : [];
    return { id, conflicts: [...overlapConflicts, ...vehicleConflicts] };
  }

  /** CAL-002 — see SetEventReminderDtoSchema's doc comment. Owner-only, matching setEventRecurrence's
   * ownership stance for the same table. */
  async setEventReminder(id: string, userId: string, reminderMinutesBefore: number | null): Promise<void> {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event not found." });
    if (event.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the event's owner can change its reminder." });
    await this.db.update(schema.calendarEvents).set({ reminderMinutesBefore, updatedAt: new Date() }).where(eq(schema.calendarEvents.id, id));
  }

  /** CAL-003 "double-booked shared assets" — set/clear which vehicle an existing event is "using" (see
   * CreateEventDtoSchema's identical field for the create-time equivalent). Owner-only, mirroring
   * setEventReminder/setEventRecurrence's ownership stance for this table. Returns any newly-found
   * `vehicle_double_booked` conflicts so the UI can show them immediately, same as createEvent. */
  async setEventVehicle(id: string, userId: string, vehicleProfileId: string | null): Promise<{ conflicts: Array<typeof schema.scheduleConflicts.$inferSelect> }> {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event not found." });
    if (event.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the event's owner can change its vehicle." });
    if (vehicleProfileId) {
      const vehicle = await this.assets.vehicleDetail(vehicleProfileId, userId);
      if (!vehicle) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    }
    await this.db
      .update(schema.calendarEvents)
      .set({ relatedEntityIds: vehicleProfileId ? [vehicleProfileId] : [], updatedAt: new Date() })
      .where(eq(schema.calendarEvents.id, id));
    const conflicts = vehicleProfileId ? await this.conflicts.vehicleConflicts(id) : [];
    return { conflicts };
  }

  /** TASK-003 — same purpose as setTaskRecurrence, for events. Owner-only. */
  async setEventRecurrence(id: string, userId: string, recurrenceRule: RecurrenceRule | null): Promise<void> {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Event not found." });
    if (event.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the event's owner can change its recurrence." });
    await this.db.update(schema.calendarEvents).set({ recurrenceRule, updatedAt: new Date() }).where(eq(schema.calendarEvents.id, id));
  }

  /** CAL-003 — every unresolved conflict involving an event this user owns, for the Life page's conflict banner. */
  async unresolvedConflicts(userId: string) {
    return this.conflicts.unresolvedConflicts(userId);
  }

  /** CAL-003 "resolve conflict" — dismiss/acknowledge. */
  async resolveConflict(conflictId: string, userId: string): Promise<void> {
    await this.conflicts.resolveConflict(conflictId, userId);
  }

  /**
   * Household adult-availability heuristic — the data need behind ConflictService.schoolTransportConflicts'
   * "is an adult actually free to drive" check (§25 Family Transport Conflicts). Thin wrapper around the
   * standalone `householdAdultBusyIntervals` (adult-availability.ts) rather than logic living directly on
   * this class: `ConflictService` needs the exact same computation and already depends on `HouseholdService`
   * itself, so keeping the real implementation in a plain function both services can call avoids a
   * ScheduleService <-> ConflictService circular dependency (ScheduleService already depends on
   * ConflictService for CAL-003) while still giving this a real, directly testable home on ScheduleService
   * as the natural "calendar/schedule domain" entry point.
   *
   * See that function's own doc comment for the full privacy discipline (spec CAL-001: "Household
   * availability may expose 'busy' without exposing private event title/details" — every interval this
   * returns is exactly `{ startMs, endMs }`, nothing else, regardless of whose private event it came from
   * or who's asking) and the best-effort caveat (a calendar-free adult isn't a guaranteed-available one).
   */
  async householdAdultBusyIntervals(householdId: string, windowStartMs: number, windowEndMs: number) {
    return computeHouseholdAdultBusyIntervals(this.db, this.households, householdId, windowStartMs, windowEndMs);
  }
}
