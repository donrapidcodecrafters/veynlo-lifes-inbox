import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { ConflictService } from "../schedule/conflict.service";
import { temporalToSortDate } from "../ingestion/temporal.util";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { SchoolIcsService } from "./school-ics.service";
import type { CreateSchoolDto, CreateSchoolSourceDto, CreatePermissionFormDto } from "./dto";

const FORM_STATE_ORDER = ["discovered", "opened", "completed", "submitted", "confirmed"] as const;
type PermissionFormState = (typeof FORM_STATE_ORDER)[number];

/**
 * §25 "School, Children & Activities" (SCH-001/002/005/006/007). School data is household-shared by
 * default (spec: "School/child data defaults household-restricted" — meaning visible to the WHOLE
 * household, not just whoever discovered it), unlike ScheduleService's calendar events which are
 * per-owner-private unless explicitly shared. `ownerOrHousehold` below is deliberately the same shape as
 * `ScheduleService.ownerOrDelegatedHousehold`/`CommerceService`'s identical helper (OR-ing active
 * membership alongside delegation — the exact bug class this session has repeatedly found and fixed
 * elsewhere: a service that checks delegation but forgets plain membership) minus the `visibility` column
 * exclusion those tables have and this one doesn't need.
 *
 * SCH-007 note: an AI-GENERIC prep-item suggestion (as opposed to a literally-sourced one, which becomes a
 * real linked task — see IngestionService.extractSchool) is deliberately never computed or persisted here.
 * There's no reliable, evidence-backed way to generate one server-side without either fabricating a fact
 * (exactly what §AI-001/2 forbids) or needing a second AI call per event just to produce a checklist —
 * the UI computes a small, clearly-"Suggested"-labeled, kind-specific checklist client-side instead (see
 * apps/web's SchoolSection), which can never be confused with a sourced fact because it's never written to
 * this table or any other.
 */
@Injectable()
export class SchoolService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(ConflictService) private readonly conflicts: ConflictService,
    @Inject(SchoolIcsService) private readonly schoolIcs: SchoolIcsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  private async ownerOrHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([this.households.delegatedHouseholdIds(userId, "schedule:read"), this.households.activeHouseholdIds(userId)]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    if (householdIds.length === 0) return eq(ownerCol, userId);
    return or(eq(ownerCol, userId), inArray(householdCol, householdIds))!;
  }

  private async assertAccess(ownerUserId: string, householdId: string | null, userId: string): Promise<void> {
    if (ownerUserId === userId) return;
    if (householdId) {
      const [delegated, member] = await Promise.all([this.households.delegatedHouseholdIds(userId, "schedule:read"), this.households.activeHouseholdIds(userId)]);
      if (delegated.includes(householdId) || member.includes(householdId)) return;
    }
    throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
  }

  // ---- Schools ----

  async listSchools(userId: string) {
    const householdIds = [...new Set([...(await this.households.activeHouseholdIds(userId)), ...(await this.households.delegatedHouseholdIds(userId, "schedule:read"))])];
    if (householdIds.length === 0) return [];
    return this.db.select().from(schema.schools).where(inArray(schema.schools.householdId, householdIds));
  }

  async createSchool(userId: string, dto: CreateSchoolDto): Promise<{ id: string }> {
    const isMember = await this.households.isActiveMember(dto.householdId, userId);
    if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    const id = generateId("school");
    await this.db.insert(schema.schools).values({ id, householdId: dto.householdId, name: dto.name, address: dto.address ?? null });
    return { id };
  }

  // ---- School sources (SCH-002 subscribe/unsubscribe) ----

  async listSchoolSources(userId: string) {
    const householdIds = [...new Set([...(await this.households.activeHouseholdIds(userId)), ...(await this.households.delegatedHouseholdIds(userId, "schedule:read"))])];
    if (householdIds.length === 0) return [];
    return this.db.select().from(schema.schoolSources).where(inArray(schema.schoolSources.householdId, householdIds));
  }

  async createSchoolSource(userId: string, dto: CreateSchoolSourceDto): Promise<{ id: string }> {
    const isMember = await this.households.isActiveMember(dto.householdId, userId);
    if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });

    // Probes the feed before creating any row — same "fail loud on connect, not on the next silent poll"
    // reasoning as IcsAdapter.connect.
    if (dto.kind === "ics" && dto.icsUrl) {
      await this.schoolIcs.probe(dto.icsUrl);
    }

    const id = generateId("schoolSource");
    await this.db.insert(schema.schoolSources).values({
      id,
      householdId: dto.householdId,
      schoolId: dto.schoolId ?? null,
      createdByUserId: userId,
      label: dto.label,
      kind: dto.kind,
      icsUrl: dto.kind === "ics" ? (dto.icsUrl ?? null) : null,
      health: "initializing",
    });

    if (dto.kind === "ics") {
      await this.queue.enqueueSchoolSourceSync({ schoolSourceId: id });
    }
    return { id };
  }

  /** "Unsubscribe" — soft, mirroring ConnectorsService.disconnect (marks disconnected rather than deleting the row, so already-synced events/evidence stay intact). */
  async unsubscribeSchoolSource(id: string, userId: string): Promise<void> {
    const [source] = await this.db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, id)).limit(1);
    if (!source) throw new NotFoundException({ code: "SCHOOL_SOURCE_NOT_FOUND", message: "School source not found." });
    await this.assertAccess(source.createdByUserId, source.householdId, userId);
    await this.db.update(schema.schoolSources).set({ disconnectedAt: new Date(), updatedAt: new Date() }).where(eq(schema.schoolSources.id, id));
  }

  /** Manual "resync now" action — the recurring scan tick (worker-main.ts's schoolSourceScanWorker) covers the periodic case; this is the user-facing "refresh" button. */
  async resyncSchoolSource(id: string, userId: string): Promise<void> {
    const [source] = await this.db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, id)).limit(1);
    if (!source) throw new NotFoundException({ code: "SCHOOL_SOURCE_NOT_FOUND", message: "School source not found." });
    await this.assertAccess(source.createdByUserId, source.householdId, userId);
    if (source.disconnectedAt) throw new BadRequestException({ code: "SOURCE_DISCONNECTED", message: "This feed has been unsubscribed." });
    await this.queue.enqueueSchoolSourceSync({ schoolSourceId: id });
  }

  // ---- School events (SCH-001/005) ----

  async listSchoolEvents(userId: string) {
    const events = await this.db
      .select()
      .from(schema.schoolEvents)
      .where(and(await this.ownerOrHousehold(userId, schema.schoolEvents.ownerUserId, schema.schoolEvents.householdId), eq(schema.schoolEvents.status, "confirmed")))
      .orderBy(asc(schema.schoolEvents.startSort));
    return events;
  }

  /** SCH-001 "assign child" — the user-driven counterpart to extractSchool's own conservative auto-assignment; dependentId: null explicitly clears a wrong assignment. */
  async assignChild(schoolEventId: string, userId: string, dependentId: string | null): Promise<void> {
    const [event] = await this.db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.id, schoolEventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "SCHOOL_EVENT_NOT_FOUND", message: "School event not found." });
    await this.assertAccess(event.ownerUserId, event.householdId, userId);

    if (dependentId) {
      if (!event.householdId) throw new BadRequestException({ code: "HOUSEHOLD_REQUIRED", message: "This event has no household to assign a child from." });
      const [dependent] = await this.db.select({ householdId: schema.dependentProfiles.householdId }).from(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dependentId)).limit(1);
      if (!dependent || dependent.householdId !== event.householdId) {
        throw new ForbiddenException({ code: "NOT_HOUSEHOLD_DEPENDENT", message: "That child isn't part of this event's household." });
      }
    }

    await this.db.update(schema.schoolEvents).set({ dependentId, updatedAt: new Date() }).where(eq(schema.schoolEvents.id, schoolEventId));

    // A transport conflict can only be detected once a dependent is actually attached (extractSchool's own
    // backstop is a no-op for an unassigned event — see schoolTransportConflicts' own guard) — re-run now.
    try {
      await this.conflicts.schoolTransportConflicts(schoolEventId, event.householdId);
    } catch {
      // best-effort, same stance as every other conflict-detection backstop in this codebase
    }
  }

  /**
   * SCH-001 "correct school" — found live: this user action is named explicitly in the spec's own SCH-001
   * action list right alongside "assign child" (which `assignChild` above already covers), but nothing
   * ever let a user fix a wrong `schoolId` — the extractor/ICS-sync-assigned school stuck permanently
   * (a household with two kids at two schools, or a district feed briefly misconfigured against the wrong
   * school row, had no way to correct a misfiled event). Mirrors `assignChild`'s exact shape: same
   * access check, same "the target must belong to this event's own household" validation, `schoolId: null`
   * explicitly clears a wrong assignment rather than requiring a replacement.
   */
  async correctSchoolEvent(schoolEventId: string, userId: string, schoolId: string | null): Promise<void> {
    const [event] = await this.db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.id, schoolEventId)).limit(1);
    if (!event) throw new NotFoundException({ code: "SCHOOL_EVENT_NOT_FOUND", message: "School event not found." });
    await this.assertAccess(event.ownerUserId, event.householdId, userId);
    await this.assertSchoolBelongsToHousehold(schoolId, event.householdId);
    await this.db.update(schema.schoolEvents).set({ schoolId, updatedAt: new Date() }).where(eq(schema.schoolEvents.id, schoolEventId));
  }

  /** SCH-001 "correct school" — the same correction for a permission form's own `schoolId` (SCH-006 forms
   * are discovered/linked to a school the same way school_events are, and can be just as wrong). */
  async correctPermissionFormSchool(permissionFormId: string, userId: string, schoolId: string | null): Promise<void> {
    const [form] = await this.db.select().from(schema.permissionForms).where(eq(schema.permissionForms.id, permissionFormId)).limit(1);
    if (!form) throw new NotFoundException({ code: "PERMISSION_FORM_NOT_FOUND", message: "Permission form not found." });
    await this.assertAccess(form.ownerUserId, form.householdId, userId);
    await this.assertSchoolBelongsToHousehold(schoolId, form.householdId);
    await this.db.update(schema.permissionForms).set({ schoolId, updatedAt: new Date() }).where(eq(schema.permissionForms.id, permissionFormId));
  }

  private async assertSchoolBelongsToHousehold(schoolId: string | null, householdId: string | null): Promise<void> {
    if (!schoolId) return; // clearing a wrong assignment never needs validation
    if (!householdId) throw new BadRequestException({ code: "HOUSEHOLD_REQUIRED", message: "This item has no household to assign a school from." });
    const [school] = await this.db.select({ householdId: schema.schools.householdId }).from(schema.schools).where(eq(schema.schools.id, schoolId)).limit(1);
    if (!school || school.householdId !== householdId) {
      throw new ForbiddenException({ code: "NOT_HOUSEHOLD_SCHOOL", message: "That school isn't part of this item's household." });
    }
  }

  /** SCH-007 — every task filed by extractSchool's literally-sourced prep-instruction loop for this event. */
  async prepTasksForEvent(schoolEventId: string, userId: string) {
    const [event] = await this.db
      .select({ householdId: schema.schoolEvents.householdId, ownerUserId: schema.schoolEvents.ownerUserId })
      .from(schema.schoolEvents)
      .where(eq(schema.schoolEvents.id, schoolEventId))
      .limit(1);
    if (!event) return [];
    await this.assertAccess(event.ownerUserId, event.householdId, userId);
    // relatedEntityIds isn't SQL-filterable the same way an encrypted column isn't — a household/owner has
    // few enough tasks that filtering the candidate set in application code (mirroring
    // IngestionService.findExistingPrepTask's identical approach) is simple and fast enough.
    const candidates = event.householdId
      ? await this.db.select().from(schema.tasks).where(eq(schema.tasks.householdId, event.householdId))
      : await this.db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, event.ownerUserId));
    return candidates.filter((t) => t.relatedEntityIds.includes(schoolEventId));
  }

  // ---- Permission forms (SCH-006) ----

  async listPermissionForms(userId: string) {
    return this.db
      .select()
      .from(schema.permissionForms)
      .where(await this.ownerOrHousehold(userId, schema.permissionForms.ownerUserId, schema.permissionForms.householdId));
  }

  async createPermissionForm(userId: string, dto: CreatePermissionFormDto): Promise<{ id: string }> {
    const isMember = await this.households.isActiveMember(dto.householdId, userId);
    if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    const dueDate: TemporalValue | null = dto.dueIso ? { precision: "date", instantUtc: null, date: dto.dueIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const id = generateId("permissionForm");
    await this.db.insert(schema.permissionForms).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId,
      title: dto.title,
      dependentId: dto.dependentId ?? null,
      schoolId: dto.schoolId ?? null,
      state: "discovered",
      dueDate,
      dueDateSort: dueDate ? temporalToSortDate(dueDate) : null,
    });
    return { id };
  }

  /**
   * SCH-006 "state: discovered, opened, completed, submitted, confirmed; no claim of submission without
   * evidence." The only writer of a NEW form row is always "discovered" (IngestionService.extractSchool /
   * createPermissionForm above); every later transition is either this explicit user action (the user's own
   * tap IS the evidence — they're telling Veynlo they did it) or, for "confirmed" specifically, a second
   * extraction matching a real confirmation email onto the same row (findExistingPermissionForm) — never a
   * transition Veynlo infers on its own. Forward-only: an accidental double-tap or reordering client bug
   * can't silently regress a form's state, and there's no legitimate product reason to move backward (a
   * genuine correction is rare enough not to need a dedicated path yet).
   */
  async advanceFormState(id: string, userId: string, nextState: PermissionFormState): Promise<void> {
    const [form] = await this.db.select().from(schema.permissionForms).where(eq(schema.permissionForms.id, id)).limit(1);
    if (!form) throw new NotFoundException({ code: "PERMISSION_FORM_NOT_FOUND", message: "Permission form not found." });
    await this.assertAccess(form.ownerUserId, form.householdId, userId);
    const currentIdx = FORM_STATE_ORDER.indexOf(form.state as PermissionFormState);
    const nextIdx = FORM_STATE_ORDER.indexOf(nextState);
    if (nextIdx <= currentIdx) {
      throw new BadRequestException({ code: "INVALID_FORM_STATE_TRANSITION", message: `Can't move a form backward from "${form.state}" to "${nextState}".` });
    }
    await this.db.update(schema.permissionForms).set({ state: nextState, updatedAt: new Date() }).where(eq(schema.permissionForms.id, id));
  }

  // ---- Family transport conflicts (school-relevant slice of CAL-003) ----

  /** Every unresolved school_transport conflict across every household this user is an active member of or delegated into — see ConflictService.schoolTransportConflicts' own doc comment for the limitation this deliberately doesn't paper over. */
  async unresolvedTransportConflicts(userId: string) {
    const householdIds = [...new Set([...(await this.households.activeHouseholdIds(userId)), ...(await this.households.delegatedHouseholdIds(userId, "schedule:read"))])];
    const results = await Promise.all(householdIds.map((id) => this.conflicts.unresolvedSchoolTransportConflicts(id)));
    return results.flat();
  }
}
