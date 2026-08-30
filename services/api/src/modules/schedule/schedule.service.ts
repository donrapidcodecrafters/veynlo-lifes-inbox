import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { ownerOrDelegatedHouseholdCondition } from "../../common/household-scope";
import { HouseholdService } from "../household/household.service";
import { GoogleCalendarAdapter } from "../connectors/google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "../connectors/microsoft-calendar.adapter";
import { SharingService } from "../shared/sharing.service";
import { parseRecurrenceRule, nextOccurrence } from "./recurrence.util";
import type { CreateTaskDto, UpdateTaskDto } from "./dto";

function dateTemporal(iso: string): TemporalValue {
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: null };
}

@Injectable()
export class ScheduleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly households: HouseholdService,
    private readonly googleCalendar: GoogleCalendarAdapter,
    private readonly microsoftCalendar: MicrosoftCalendarAdapter,
    private readonly sharing: SharingService,
  ) {}

  /**
   * FAM-006 enforcement, mirroring CommerceService.ownerOrDelegatedHousehold. Unlike commerce, a
   * delegated household's rows additionally exclude `visibility: "private"` when a visibility column is
   * given (calendar_events only — tasks has none) so a member's explicitly private event doesn't leak to
   * a caregiver just because they hold a household-wide grant; the owner's own rows are never filtered by
   * visibility.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn, visibilityCol?: AnyPgColumn) {
    const householdIds = await this.households.delegatedHouseholdIds(userId, "schedule:read");
    return ownerOrDelegatedHouseholdCondition(userId, householdIds, ownerCol, householdCol, visibilityCol);
  }

  async upcomingEvents(userId: string) {
    return this.db
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          await this.ownerOrDelegatedHousehold(userId, schema.calendarEvents.ownerUserId, schema.calendarEvents.householdId, schema.calendarEvents.visibility),
          gte(schema.calendarEvents.startSort, new Date()),
        ),
      )
      .orderBy(asc(schema.calendarEvents.startSort));
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
      const householdIds = event.householdId ? await this.households.delegatedHouseholdIds(userId, "schedule:read") : [];
      const householdAllowed = event.householdId && householdIds.includes(event.householdId) && event.visibility !== "private";
      // SHARE-001 direct object grant — works regardless of visibility/household-delegation, same reasoning
      // as DocumentsService's identical extension.
      if (!householdAllowed && !(await this.sharing.hasActiveGrant("calendar_event", eventId, userId))) return null;
    }
    return { event, evidence: await this.evidenceViaInboxItem("calendar_event", eventId) };
  }

  /** §Sharing expansion — same shape as AttentionService's identical pair, generalized via SharingService. Owner-only, same as pushEventToCalendar (a household member with read access still isn't the one who should be minting a public link for someone else's event). */
  async createShareLink(eventId: string, userId: string) {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });
    return this.sharing.createShareLink("calendar_event", eventId, userId);
  }

  async revokeShareLinks(eventId: string, userId: string) {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });
    await this.sharing.revokeShareLinks("calendar_event", eventId, userId);
  }

  /**
   * §HH-002 "object-level privacy badge" — real, previously-missing gap: ownerOrDelegatedHousehold above
   * has correctly excluded `visibility: "private"` events from a delegate's view since that check was
   * built, but nothing anywhere ever set an event's visibility to anything but "private" at creation —
   * the whole caregiver-delegation feature (schedule:read scope) was functionally inert because there was
   * never a real event for a delegate to actually see. "selected_people"/"shared_link" aren't offered
   * here for the same reason as DocumentsService's identical method — this codebase's actual enforcement
   * only distinguishes private vs. not-private today.
   */
  async setEventVisibility(eventId: string, userId: string, visibility: "private" | "household") {
    const [event] = await this.db
      .select({ ownerUserId: schema.calendarEvents.ownerUserId, householdId: schema.calendarEvents.householdId })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, eventId))
      .limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });
    if (visibility === "household" && !event.householdId) {
      throw new BadRequestException({
        code: "NO_HOUSEHOLD",
        message: "This account isn't part of a household yet, so there's no one to share this with.",
      });
    }
    await this.db.update(schema.calendarEvents).set({ visibility, updatedAt: new Date() }).where(eq(schema.calendarEvents.id, eventId));
  }

  /** PEO-004 "person linkage" — reuses calendarEvents.relatedEntityIds, a column that already existed
   * with no reader/writer anywhere in the codebase; same mutation standard as setEventVisibility. */
  async setEventPersonLink(eventId: string, userId: string, personId: string, linked: boolean): Promise<void> {
    const [person] = await this.db
      .select({ id: schema.canonicalEntities.id })
      .from(schema.canonicalEntities)
      .where(and(eq(schema.canonicalEntities.id, personId), eq(schema.canonicalEntities.type, "person"), eq(schema.canonicalEntities.ownerUserId, userId)))
      .limit(1);
    if (!person) throw new NotFoundException({ code: "PERSON_NOT_FOUND", message: "Not found." });

    const [event] = await this.db
      .select({ ownerUserId: schema.calendarEvents.ownerUserId, relatedEntityIds: schema.calendarEvents.relatedEntityIds })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, eventId))
      .limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });

    const next = linked ? [...new Set([...event.relatedEntityIds, personId])] : event.relatedEntityIds.filter((id) => id !== personId);
    await this.db.update(schema.calendarEvents).set({ relatedEntityIds: next, updatedAt: new Date() }).where(eq(schema.calendarEvents.id, eventId));
  }

  /**
   * SHARE-001 "direct object sharing to a specific household member" — same shape as DocumentsService's
   * identical method. Grants one named household member view access regardless of the event's own
   * visibility setting; grantee must be a real active member of the same household.
   */
  async shareEventWithMember(eventId: string, userId: string, granteeUserId: string) {
    const [event] = await this.db
      .select({ ownerUserId: schema.calendarEvents.ownerUserId, householdId: schema.calendarEvents.householdId })
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.id, eventId))
      .limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });
    if (!event.householdId) {
      throw new BadRequestException({ code: "NO_HOUSEHOLD", message: "This account isn't part of a household yet, so there's no one to share this with." });
    }
    if (granteeUserId === userId) {
      throw new BadRequestException({ code: "SELF_GRANT", message: "You already have access to your own event." });
    }
    const [membership] = await this.db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, event.householdId), eq(schema.householdMemberships.userId, granteeUserId), eq(schema.householdMemberships.status, "active")));
    if (!membership) {
      throw new BadRequestException({ code: "NOT_A_MEMBER", message: "That person isn't an active member of your household." });
    }
    return this.sharing.grantAccess("calendar_event", eventId, granteeUserId, userId);
  }

  async revokeEventMemberAccess(eventId: string, userId: string, grantId: string) {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });
    await this.sharing.revokeGrant(grantId, userId);
  }

  async listEventMemberGrants(eventId: string, userId: string) {
    const [event] = await this.db.select({ ownerUserId: schema.calendarEvents.ownerUserId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });
    return this.sharing.listGrants("calendar_event", eventId);
  }

  /**
   * CAL-001 "write-back capability" — explicit, user-triggered push (never automatic on every local edit,
   * per the spec's own "gates it behind an explicit write-back toggle"). Picks whichever calendar
   * connection the user has active; if they have both, Google wins arbitrarily since there's no per-event
   * "which calendar" preference to consult yet — a real limitation, not a silent bug, worth revisiting if
   * anyone actually connects both providers and wants a choice. `providerEventId` already set (from a
   * previous push, or because this event was itself synced FROM that same provider) means this updates in
   * place instead of creating a duplicate event on the provider's side.
   */
  /** CAL-002 — `destinationProvider` lets the caller choose which connected calendar receives the push
   * when more than one is connected (previously always silently preferred Google over Microsoft with no
   * way to choose otherwise); omitted, it falls back to that same Google-first default for backward
   * compatibility. `reminderMinutesBefore` sets a real alert on the created/updated event — previously
   * never set at all, so a pushed event relied entirely on the destination calendar's own generic default
   * (or none), regardless of how time-sensitive the underlying Veynlo item (a return deadline, a bill due
   * date) actually was. `null`/omitted defers to the destination calendar's own default reminders. */
  async pushEventToCalendar(
    eventId: string,
    userId: string,
    options: { destinationProvider?: "google_calendar" | "microsoft_calendar"; reminderMinutesBefore?: number | null } = {},
  ): Promise<{ provider: string; providerEventId: string }> {
    const [event] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Not found." });
    if (event.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your event." });

    const connections = await this.db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.ownerUserId, userId),
          inArray(schema.connections.provider, ["google_calendar", "microsoft_calendar"]),
          ne(schema.connections.health, "disconnected"),
        ),
      );
    const googleConnection = connections.find((c) => c.provider === "google_calendar");
    const microsoftConnection = connections.find((c) => c.provider === "microsoft_calendar");
    if (!googleConnection && !microsoftConnection) {
      throw new BadRequestException({ code: "NO_CALENDAR_CONNECTION", message: "Connect Google or Microsoft Calendar first to push events there." });
    }
    if (options.destinationProvider === "google_calendar" && !googleConnection) {
      throw new BadRequestException({ code: "NO_CALENDAR_CONNECTION", message: "Connect Google Calendar first to push events there." });
    }
    if (options.destinationProvider === "microsoft_calendar" && !microsoftConnection) {
      throw new BadRequestException({ code: "NO_CALENDAR_CONNECTION", message: "Connect Microsoft Calendar first to push events there." });
    }

    const pushArgs = {
      providerEventId: event.providerEventId,
      title: event.title,
      start: event.start,
      end: event.end,
      isAllDay: event.isAllDay,
      location: event.location,
      reminderMinutesBefore: options.reminderMinutesBefore ?? null,
    };
    const useGoogle = options.destinationProvider ? options.destinationProvider === "google_calendar" : Boolean(googleConnection);
    const [provider, result] = useGoogle
      ? ["google_calendar", await this.googleCalendar.pushEvent(googleConnection!.id, pushArgs)]
      : ["microsoft_calendar", await this.microsoftCalendar.pushEvent(microsoftConnection!.id, pushArgs)];

    await this.db.update(schema.calendarEvents).set({ providerEventId: result.providerEventId, updatedAt: new Date() }).where(eq(schema.calendarEvents.id, eventId));
    return { provider, providerEventId: result.providerEventId };
  }

  async tasks(userId: string) {
    return this.db
      .select()
      .from(schema.tasks)
      .where(await this.ownerOrDelegatedHousehold(userId, schema.tasks.ownerUserId, schema.tasks.householdId))
      .orderBy(asc(schema.tasks.dueSort));
  }

  /** TASK-001 "Life Inbox native obligations" — previously tasks could only ever be populated by Apple Reminders sync; this is the first way to create one directly in the app. */
  async createTask(userId: string, householdId: string | null, dto: CreateTaskDto) {
    if (dto.recurrenceRule && !parseRecurrenceRule(dto.recurrenceRule)) {
      throw new BadRequestException({ code: "INVALID_RECURRENCE_RULE", message: "Unsupported recurrence rule. Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY;INTERVAL=n." });
    }
    const id = generateId("task");
    const dueCondition = dto.dueDateIso ? dateTemporal(dto.dueDateIso) : null;
    await this.db.insert(schema.tasks).values({
      id,
      ownerUserId: userId,
      householdId,
      title: dto.title,
      dueCondition,
      dueSort: dto.dueDateIso ? new Date(dto.dueDateIso) : null,
      priority: dto.priority ?? "medium",
      consequence: dto.consequence ?? null,
      recurrenceRule: dto.recurrenceRule ?? null,
    });
    return { id };
  }

  async updateTask(id: string, userId: string, dto: UpdateTaskDto) {
    if (dto.recurrenceRule && !parseRecurrenceRule(dto.recurrenceRule)) {
      throw new BadRequestException({ code: "INVALID_RECURRENCE_RULE", message: "Unsupported recurrence rule. Supported: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY;INTERVAL=n." });
    }
    const task = await this.assertOwnedTask(id, userId);
    const patch: Partial<typeof schema.tasks.$inferInsert> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.consequence !== undefined) patch.consequence = dto.consequence;
    if (dto.recurrenceRule !== undefined) patch.recurrenceRule = dto.recurrenceRule;
    if (dto.dueDateIso !== undefined) {
      patch.dueCondition = dto.dueDateIso ? dateTemporal(dto.dueDateIso) : null;
      patch.dueSort = dto.dueDateIso ? new Date(dto.dueDateIso) : null;
    }
    await this.db.update(schema.tasks).set(patch).where(eq(schema.tasks.id, task.id));
  }

  /** Only ever deletes a task this app created — a Reminders-synced task would just resurrect itself on the next sync, so deleting it here would silently misrepresent what actually happened; the user has to delete it in Reminders itself. */
  async deleteTask(id: string, userId: string) {
    const task = await this.assertOwnedTask(id, userId);
    if (task.externalSyncProvider) {
      throw new BadRequestException({
        code: "EXTERNAL_TASK_NOT_DELETABLE",
        message: `This task is synced from ${task.externalSyncProvider === "apple_reminders" ? "Apple Reminders" : task.externalSyncProvider} — delete it there instead.`,
      });
    }
    await this.db.delete(schema.tasks).where(eq(schema.tasks.id, task.id));
  }

  /**
   * TASK-003 "recurrence engine" (scoped-down version, see recurrence.util.ts) — completing a recurring
   * task marks THIS occurrence done and, if its recurrenceRule parses, immediately creates the next one
   * rather than the recurrence silently ending the first time someone checks it off.
   */
  async completeTask(id: string, userId: string) {
    const task = await this.assertOwnedTask(id, userId);
    await this.db.update(schema.tasks).set({ state: "completed", updatedAt: new Date() }).where(eq(schema.tasks.id, task.id));

    const rule = task.recurrenceRule ? parseRecurrenceRule(task.recurrenceRule) : null;
    if (!rule) return;
    const baseDate = task.dueSort ?? new Date();
    const next = nextOccurrence(baseDate, rule);
    const nextIso = next.toISOString().slice(0, 10);
    await this.db.insert(schema.tasks).values({
      id: generateId("task"),
      ownerUserId: task.ownerUserId,
      householdId: task.householdId,
      title: task.title,
      dueCondition: dateTemporal(nextIso),
      dueSort: next,
      priority: task.priority,
      consequence: task.consequence,
      recurrenceRule: task.recurrenceRule,
    });
  }

  private async assertOwnedTask(id: string, userId: string) {
    const [task] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    if (!task) throw new NotFoundException({ code: "TASK_NOT_FOUND", message: "Not found." });
    if (task.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your task." });
    return task;
  }

  /**
   * CAL-003 "conflict detection", scoped to the tractable slice: real time-overlap between two of the
   * caller's own calendar events. Travel-time/dependent-transportation/shared-asset conflicts need a
   * Places/People model that doesn't exist yet — a separate, larger effort. Runs on demand (called when
   * the Life page loads conflicts), not as a background tick — a deliberate MVP simplification; a
   * `schedule_conflicts` row is persisted the first time a pair is detected so repeated calls don't
   * duplicate it, and `resolvedAt` is set once a previously-conflicting pair no longer overlaps (one of
   * the events moved or was deleted).
   */
  async detectConflicts(userId: string) {
    const events = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.ownerUserId, userId), eq(schema.calendarEvents.status, "confirmed")));

    const withWindows = events
      .map((e) => {
        const start = e.startSort;
        if (!start) return null;
        const endTemporal = e.end?.instantUtc ? new Date(e.end.instantUtc) : e.end?.date ? new Date(`${e.end.date}T23:59:59`) : null;
        const end = endTemporal ?? new Date(start.getTime() + 60 * 60 * 1000); // no explicit end — assume 1 hour
        return { id: e.id, start, end };
      })
      .filter((e): e is { id: string; start: Date; end: Date } => e !== null);

    const overlappingPairs: [string, string][] = [];
    for (let i = 0; i < withWindows.length; i++) {
      for (let j = i + 1; j < withWindows.length; j++) {
        const a = withWindows[i]!;
        const b = withWindows[j]!;
        if (a.start < b.end && b.start < a.end) overlappingPairs.push([a.id, b.id].sort() as [string, string]);
      }
    }

    const existing = await this.db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.kind, "time_overlap"));
    const existingByKey = new Map(existing.map((c) => [c.involvedEventIds.slice().sort().join(","), c]));

    for (const pair of overlappingPairs) {
      const key = pair.join(",");
      if (!existingByKey.has(key)) {
        await this.db.insert(schema.scheduleConflicts).values({ id: generateId("scheduleConflict"), kind: "time_overlap", involvedEventIds: pair });
      }
    }

    // A conflict resolves itself once its pair no longer overlaps (an event moved/was deleted) — not
    // reflected in `existingByKey` until the next call, which is fine: this only ever marks conflicts
    // stale on this same read, never leaves one stuck open forever.
    const stillOverlapping = new Set(overlappingPairs.map((p) => p.join(",")));
    for (const conflict of existing) {
      const key = conflict.involvedEventIds.slice().sort().join(",");
      if (!stillOverlapping.has(key) && !conflict.resolvedAt) {
        await this.db.update(schema.scheduleConflicts).set({ resolvedAt: new Date() }).where(eq(schema.scheduleConflicts.id, conflict.id));
      }
    }

    // schedule_conflicts has no direct owner column (only a nullable householdId), so scoping to "this
    // user's own conflicts" is done here in JS against the event-id set already fetched above, rather
    // than a second query.
    const ownEventIds = new Set(events.map((e) => e.id));
    const all = await this.db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.kind, "time_overlap"));
    return all.filter((c) => c.involvedEventIds.some((id) => ownEventIds.has(id)));
  }
}
