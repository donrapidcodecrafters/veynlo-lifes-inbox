import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { IdentityService } from "../identity/identity.service";
import { DocumentsService, HEALTH_DOCUMENT_TYPES } from "../documents/documents.service";
import { DataExportService } from "../data-export/data-export.service";
import { SearchIndexService } from "../search/search-index.service";
import type { CreateHealthAppointmentDto, CreateRefillReminderDto } from "./dto";

/**
 * §27 "Health Logistics (Non-Diagnostic)" (HLTH-001..005). This service deliberately owns no clinical
 * content of any kind — see `HealthAppointmentExtractionSchema`'s and `IngestionService
 * .extractHealthAppointment`'s doc comments for how the non-diagnostic boundary is enforced on the AI-
 * extraction side; everything here is either a plain user-entered logistics field or a passthrough to
 * `DocumentsService`/`SharingService`, neither of which this module reimplements.
 *
 * ACCESS CONTROL — the one thing this module gets to enforce differently from every other domain in this
 * app, and the reason it isn't just "ScheduleService with different columns": every other
 * `ownerOrDelegatedHousehold`-shaped helper in this codebase (Schedule/Commerce/Documents/Lists/Assets) OR's
 * a household's `activeHouseholdIds` membership into the access condition — meaning any active household
 * member sees a shared, non-private row, full stop. Chapter 27's own line is different: "Permissions /
 * consent: Explicit category consent; private by default; strong access controls." Health-logistics rows
 * must NOT become visible to a household member just because they're active in the household — only three
 * things ever grant access to another person's row here:
 *   1. Ownership (`ownerUserId === userId`), always.
 *   2. An explicit `resourceGrants` row via `SharingService`, scoped to one specific appointment/reminder
 *      (HLTH-005 "granular field/document sharing; avoid blanket medical history access").
 *   3. An explicit "health:read" caregiver delegation (`CAREGIVER_DELEGATION_SCOPES` in
 *      household/dto.ts) — itself a deliberate, revocable, scoped opt-in an owner grants, never automatic
 *      from plain membership — AND only for a row the owner has additionally marked `visibility: "household"`
 *      (see `setAppointmentVisibility`); a still-"private" row stays invisible even to a "health:read"
 *      delegate. `refillReminders` has no `visibility` column (shared with Pets — see
 *      packages/db/src/schema/assets.ts), so for that table delegation alone gates household-scoped access.
 */
@Injectable()
export class HealthLogisticsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(DataExportService) private readonly dataExport: DataExportService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional
    // `new HealthLogisticsService(...)` test construction keeps compiling unchanged.
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  // ---------------------------------------------------------------------------------------------------
  // Health appointments (HLTH-001)
  // ---------------------------------------------------------------------------------------------------

  private async appointmentAccessCondition(userId: string) {
    // "health:read" only — deliberately never OR's in HouseholdService.activeHouseholdIds, unlike every
    // other domain's ownerOrDelegatedHousehold helper. See this class's own doc comment.
    const delegatedIds = await this.households.delegatedHouseholdIds(userId, "health:read");
    const grantedIds = await this.sharing.grantedResourceIds("health_appointment", userId);
    const conditions = [eq(schema.healthAppointments.ownerUserId, userId)];
    if (delegatedIds.length > 0) {
      conditions.push(and(inArray(schema.healthAppointments.householdId, delegatedIds), ne(schema.healthAppointments.visibility, "private"))!);
    }
    if (grantedIds.length > 0) {
      conditions.push(inArray(schema.healthAppointments.id, grantedIds));
    }
    return or(...conditions)!;
  }

  /** Upcoming (or undated) appointments this user can see — mirrors ScheduleService.upcomingEvents' own
   * "gte(startSort, now)" filter, adapted for healthAppointments' dateTimeSort. */
  async listAppointments(userId: string) {
    const access = await this.appointmentAccessCondition(userId);
    return this.db
      .select()
      .from(schema.healthAppointments)
      .where(and(access, isNull(schema.healthAppointments.deletedAt), or(isNull(schema.healthAppointments.dateTimeSort), gte(schema.healthAppointments.dateTimeSort, new Date()))!))
      .orderBy(schema.healthAppointments.dateTimeSort);
  }

  async appointmentDetail(id: string, userId: string) {
    const [appt] = await this.db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.id, id)).limit(1);
    if (!appt || appt.deletedAt) throw new NotFoundException({ code: "HEALTH_APPOINTMENT_NOT_FOUND", message: "Not found." });
    if (appt.ownerUserId !== userId) {
      let householdAccess = false;
      if (appt.householdId && appt.visibility !== "private") {
        const delegatedIds = await this.households.delegatedHouseholdIds(userId, "health:read");
        householdAccess = delegatedIds.includes(appt.householdId);
      }
      if (!householdAccess && !(await this.sharing.hasActiveGrant("health_appointment", id, userId))) {
        throw new ForbiddenException({ code: "NOT_OWNER", message: "You don't have access to this appointment." });
      }
    }
    // Bills linked to this appointment (HLTH-004) — surfaced here rather than a separate endpoint, since
    // the appointment detail view is exactly where "what does this cost me" belongs.
    const linkedBills = await this.db.select().from(schema.bills).where(eq(schema.bills.healthAppointmentId, id));
    // HLTH-001 "forms/tasks" linkage — mirrors linkedBills exactly (see linkTaskToAppointment below); only
    // the appointment's own owner can ever set tasks.healthAppointmentId to this id (linkTaskToAppointment
    // requires the caller to own BOTH rows), so no further owner filter is needed here, same reasoning as
    // linkedBills above.
    const linkedTasks = await this.db.select().from(schema.tasks).where(eq(schema.tasks.healthAppointmentId, id));
    // HLTH-001/002 "attach form/card/bill" — insurance-card/EOB documents linked via documents.linkedEntityIds
    // (see linkDocumentToAppointment below). Not SQL-filterable the same way an encrypted/jsonb column isn't
    // elsewhere in this codebase (see school.service.ts's identical comment on tasks.relatedEntityIds) — one
    // owner-scoped, type-scoped query, filtered in application code. Same "only the owner could've linked
    // it" reasoning as linkedBills/linkedTasks means no cross-owner leak is possible here either.
    const candidateDocuments = await this.db
      .select()
      .from(schema.documents)
      .where(and(eq(schema.documents.ownerUserId, appt.ownerUserId), isNull(schema.documents.deletedAt), inArray(schema.documents.documentType, [...HEALTH_DOCUMENT_TYPES])));
    const linkedDocuments = candidateDocuments.filter((d) => d.linkedEntityIds.includes(id));
    // AI-001 "Evidence-backed fact creation" — `healthAppointments.sourceEventId` was populated by
    // IngestionService.extractHealthAppointment since the discovered-appointment path shipped, but nothing
    // ever read it back: unlike CommerceService's purchases/bills/subscriptions/etc. (each of which exposes
    // an `evidence` field via its own evidenceForSourceEvent/evidenceViaInboxItem), appointmentDetail
    // returned no evidence at all, and neither the web nor mobile detail page had anywhere to show a "why
    // am I seeing this?" trail for a discovered appointment. Access is governed entirely by the ownership/
    // grant/delegation check already enforced above — this only ever reveals the source event already
    // proven to belong to (or be shared for) this exact appointment, never a wider slice of the user's mail.
    const evidence = await this.evidenceForSourceEvent(appt.sourceEventId);
    return { appointment: appt, linkedBills, linkedTasks, linkedDocuments, evidence };
  }

  /** Mirrors CommerceService.evidenceForSourceEvent exactly (§39.2/AI-001 "why am I seeing this?") —
   * `source_events` deliberately never stores the full body, only what was captured at ingest time. */
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

  async createAppointment(userId: string, dto: CreateHealthAppointmentDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    const dateTime: TemporalValue = { precision: "instant", instantUtc: new Date(dto.startIso).toISOString(), date: null, timezone: null, sourceText: null };
    const id = generateId("healthAppointment");
    await this.db.insert(schema.healthAppointments).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      visibility: "private", // HLTH-001/002 "private by default" — see setAppointmentVisibility for the explicit opt-in
      providerName: dto.providerName ?? null,
      appointmentType: dto.appointmentType ?? null,
      dateTime,
      dateTimeSort: new Date(dateTime.instantUtc!),
      location: dto.location ?? null,
      prepInstructions: dto.prepInstructions ?? null,
      status: "confirmed",
      source: "manual",
      confidenceBand: "verified",
    });
    await this.searchIndex?.upsert({
      resourceType: "health_appointment",
      resourceId: id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      sensitivity: "highly_sensitive",
      title: dto.providerName ?? dto.appointmentType ?? "Health appointment",
      bodyText: [dto.appointmentType, dto.location, dto.prepInstructions].filter(Boolean).join(" — "),
    });
    return { id };
  }

  private async assertOwnedAppointment(id: string, userId: string) {
    const [appt] = await this.db.select({ ownerUserId: schema.healthAppointments.ownerUserId, householdId: schema.healthAppointments.householdId }).from(schema.healthAppointments).where(eq(schema.healthAppointments.id, id)).limit(1);
    if (!appt) throw new NotFoundException({ code: "HEALTH_APPOINTMENT_NOT_FOUND", message: "Not found." });
    if (appt.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your appointment." });
    return appt;
  }

  /** HLTH-005 — the explicit opt-in that lets a "health:read" caregiver delegate see this ONE appointment;
   * a household's other members/delegates still see nothing until the owner does this for each row they
   * choose to share (HLTH-005 "granular ... avoid blanket medical history access"). Owner-only. */
  async setAppointmentVisibility(id: string, userId: string, visibility: "private" | "household"): Promise<void> {
    const appt = await this.assertOwnedAppointment(id, userId);
    if (visibility === "household" && !appt.householdId) {
      throw new BadRequestException({ code: "HOUSEHOLD_REQUIRED", message: "Add this appointment to a household before sharing it with caregivers." });
    }
    await this.db.update(schema.healthAppointments).set({ visibility, updatedAt: new Date() }).where(eq(schema.healthAppointments.id, id));
  }

  async deleteAppointment(id: string, userId: string): Promise<void> {
    await this.assertOwnedAppointment(id, userId);
    await this.db.update(schema.healthAppointments).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.healthAppointments.id, id));
  }

  async createAppointmentGrant(id: string, userId: string, granteeEmail: string, expiresInDays?: number) {
    await this.assertOwnedAppointment(id, userId);
    return this.sharing.createResourceGrant("health_appointment", id, userId, granteeEmail, expiresInDays);
  }

  async listAppointmentGrants(id: string, userId: string) {
    await this.assertOwnedAppointment(id, userId);
    return this.sharing.listResourceGrants("health_appointment", id);
  }

  async revokeAppointmentGrant(grantId: string, userId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, userId);
  }

  /**
   * HLTH-005 deliberately never offers an unauthenticated public link for health-logistics content — that
   * would be handing PHI-like scheduling data to "anyone with the URL," a materially different risk than a
   * document's "highly_sensitive" tier merely disqualifying (see DocumentsService.createShareLink). Direct,
   * named-recipient grants (createAppointmentGrant, above) are the only sharing mechanism offered. This
   * still validates ownership before rejecting (never leaks whether an id exists to a non-owner), and the
   * list/revoke endpoints stay wired so the generic ShareResourcePanel component doesn't error on load.
   */
  async createAppointmentShareLink(id: string, userId: string): Promise<never> {
    await this.assertOwnedAppointment(id, userId);
    throw new ForbiddenException({
      code: "PUBLIC_LINKS_DISABLED_FOR_HEALTH",
      message: "Health-logistics items can't be shared via public link. Share directly with someone's Veynlo account instead.",
    });
  }

  async listAppointmentShareLinks(id: string, userId: string) {
    await this.assertOwnedAppointment(id, userId);
    return this.sharing.listShareLinks("health_appointment", id);
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAppointmentAccessEvents(id: string, userId: string) {
    await this.assertOwnedAppointment(id, userId);
    return this.sharing.listAccessEvents("health_appointment", id);
  }

  // ---------------------------------------------------------------------------------------------------
  // Medication refill reminders (HLTH-003) — reuses the generic `refillReminders` table Pets (PET-003)
  // built, scoped here to `petProfileId IS NULL` (the human/health side of that shared table — see its own
  // doc comment in packages/db/src/schema/assets.ts).
  // ---------------------------------------------------------------------------------------------------

  private async refillAccessCondition(userId: string) {
    const delegatedIds = await this.households.delegatedHouseholdIds(userId, "health:read");
    const conditions = [eq(schema.refillReminders.ownerUserId, userId)];
    if (delegatedIds.length > 0) conditions.push(inArray(schema.refillReminders.householdId, delegatedIds));
    return or(...conditions)!;
  }

  async listRefillReminders(userId: string) {
    const access = await this.refillAccessCondition(userId);
    return this.db
      .select()
      .from(schema.refillReminders)
      .where(and(access, isNull(schema.refillReminders.petProfileId), isNull(schema.refillReminders.deletedAt)))
      .orderBy(schema.refillReminders.nextRefillDateSort);
  }

  async createRefillReminder(userId: string, dto: CreateRefillReminderDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    if (dto.dependentProfileId) {
      const [dependent] = await this.db.select({ householdId: schema.dependentProfiles.householdId }).from(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dto.dependentProfileId)).limit(1);
      if (!dependent || dependent.householdId !== dto.householdId) {
        throw new BadRequestException({ code: "INVALID_DEPENDENT", message: "That dependent isn't part of the household you specified." });
      }
    }
    const nextRefillDate: TemporalValue = { precision: "date", instantUtc: null, date: dto.nextRefillIso.slice(0, 10), timezone: null, sourceText: null };
    const id = generateId("refillReminder");
    await this.db.insert(schema.refillReminders).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      petProfileId: null,
      dependentProfileId: dto.dependentProfileId ?? null,
      medicationName: dto.medicationName,
      nextRefillDate,
      nextRefillDateSort: new Date(`${nextRefillDate.date}T00:00:00Z`),
      pharmacy: dto.pharmacy ?? null,
      notes: dto.notes ?? null,
    });
    return { id };
  }

  private async assertOwnedRefillReminder(id: string, userId: string) {
    const [row] = await this.db.select({ ownerUserId: schema.refillReminders.ownerUserId }).from(schema.refillReminders).where(eq(schema.refillReminders.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: "REFILL_REMINDER_NOT_FOUND", message: "Not found." });
    if (row.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your refill reminder." });
  }

  /** HLTH-001/003 "mark picked up" user action. */
  async markRefillPickedUp(id: string, userId: string): Promise<void> {
    await this.assertOwnedRefillReminder(id, userId);
    await this.db.update(schema.refillReminders).set({ pickedUpAt: new Date(), updatedAt: new Date() }).where(eq(schema.refillReminders.id, id));
  }

  async deleteRefillReminder(id: string, userId: string): Promise<void> {
    await this.assertOwnedRefillReminder(id, userId);
    await this.db.update(schema.refillReminders).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.refillReminders.id, id));
  }

  // ---------------------------------------------------------------------------------------------------
  // Medical bill/EOB organizer (HLTH-004) — reuses the existing bills table (packages/db/src/schema/
  // commerce.ts) rather than a parallel billing system; this only adds the appointment link + the
  // deterministic mismatch flag.
  // ---------------------------------------------------------------------------------------------------

  /**
   * Links a bill the caller owns to a health appointment they own, and — the ONLY place this module ever
   * flags a discrepancy — sets `needsAmountReview` on both bills when this bill and another bill already
   * linked to the same appointment have two *different*, both-non-null `amountDueMinorUnits`. This is
   * exactly the chapter's own line: "Highlight mismatched amounts only as 'review' unless deterministic
   * source facts confirm discrepancy" — two literal extracted/entered amounts genuinely disagreeing is a
   * deterministic fact, never an inference; nothing here ever asserts which amount is "correct" or that a
   * billing error occurred, only that the two disagree and a human should look.
   */
  async linkBillToAppointment(billId: string, userId: string, healthAppointmentId: string): Promise<{ needsAmountReview: boolean }> {
    const [bill] = await this.db.select().from(schema.bills).where(eq(schema.bills.id, billId)).limit(1);
    if (!bill) throw new NotFoundException({ code: "BILL_NOT_FOUND", message: "Not found." });
    if (bill.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your bill." });
    await this.assertOwnedAppointment(healthAppointmentId, userId);

    const siblings = await this.db
      .select({ id: schema.bills.id, amountDueMinorUnits: schema.bills.amountDueMinorUnits })
      .from(schema.bills)
      .where(and(eq(schema.bills.healthAppointmentId, healthAppointmentId), ne(schema.bills.id, billId)));
    const mismatch = siblings.some((s) => s.amountDueMinorUnits != null && bill.amountDueMinorUnits != null && s.amountDueMinorUnits !== bill.amountDueMinorUnits);

    await this.db.update(schema.bills).set({ healthAppointmentId, needsAmountReview: mismatch || bill.needsAmountReview, updatedAt: new Date() }).where(eq(schema.bills.id, billId));
    if (mismatch) {
      const mismatchedSiblingIds = siblings
        .filter((s) => s.amountDueMinorUnits != null && bill.amountDueMinorUnits != null && s.amountDueMinorUnits !== bill.amountDueMinorUnits)
        .map((s) => s.id);
      if (mismatchedSiblingIds.length > 0) {
        await this.db.update(schema.bills).set({ needsAmountReview: true, updatedAt: new Date() }).where(inArray(schema.bills.id, mismatchedSiblingIds));
      }
    }
    return { needsAmountReview: mismatch || bill.needsAmountReview };
  }

  /** Lets the owner dismiss a review flag once they've looked into it — this module never clears it
   * automatically, since only a human can decide the discrepancy is understood/resolved. */
  async clearBillAmountReview(billId: string, userId: string): Promise<void> {
    const [bill] = await this.db.select({ ownerUserId: schema.bills.ownerUserId }).from(schema.bills).where(eq(schema.bills.id, billId)).limit(1);
    if (!bill) throw new NotFoundException({ code: "BILL_NOT_FOUND", message: "Not found." });
    if (bill.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your bill." });
    await this.db.update(schema.bills).set({ needsAmountReview: false, updatedAt: new Date() }).where(eq(schema.bills.id, billId));
  }

  // ---------------------------------------------------------------------------------------------------
  // "Forms/tasks" linkage (HLTH-001) — mirrors the bill-linking pair above exactly: an existing tasks row
  // ("bring insurance card," "fast for 8 hours before") the caller owns can be attached to one health
  // appointment they own via `tasks.healthAppointmentId` (schedule.ts), the same one-to-many FK shape
  // `bills.healthAppointmentId` already uses. Found live via a spec-retraceability audit: the backend had
  // no way to ever set this column and no UI anywhere surfaced it, despite HLTH-001 explicitly naming
  // "forms/tasks" alongside "bills" as things a health appointment should be able to carry.
  // ---------------------------------------------------------------------------------------------------

  private async assertOwnedTask(taskId: string, userId: string) {
    const [task] = await this.db.select({ ownerUserId: schema.tasks.ownerUserId }).from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1);
    if (!task) throw new NotFoundException({ code: "TASK_NOT_FOUND", message: "Task not found." });
    if (task.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your task." });
  }

  /** Owner-only on both sides, same stance as linkBillToAppointment — a task can only ever prep for ONE
   * appointment at a time (re-linking simply repoints it), and a household member/delegate/grantee can
   * never attach their own task to someone else's appointment, or vice versa. */
  async linkTaskToAppointment(taskId: string, userId: string, healthAppointmentId: string): Promise<void> {
    await this.assertOwnedTask(taskId, userId);
    await this.assertOwnedAppointment(healthAppointmentId, userId);
    await this.db.update(schema.tasks).set({ healthAppointmentId, updatedAt: new Date() }).where(eq(schema.tasks.id, taskId));
  }

  /** Detaches a task from whichever appointment it's currently linked to (a no-op if it wasn't linked). */
  async unlinkTaskFromAppointment(taskId: string, userId: string): Promise<void> {
    await this.assertOwnedTask(taskId, userId);
    await this.db.update(schema.tasks).set({ healthAppointmentId: null, updatedAt: new Date() }).where(eq(schema.tasks.id, taskId));
  }

  // ---------------------------------------------------------------------------------------------------
  // Insurance card / EOB document vault (HLTH-002) — thin wrapper around DocumentsService adding a
  // mandatory step-up re-authentication on top of its normal (already-stricter, see HEALTH_DOCUMENT_TYPES)
  // access check, for documentTypes "insurance_card"/"eob" only.
  // ---------------------------------------------------------------------------------------------------

  /**
   * §28.9-style step-up gate, reusing IdentityService.verifyStepUpPassword exactly the way
   * EmergencyBinderService.getBinder does. `documents.documentDetail`/`signedUrl` already enforce the
   * baseline access check (owner, an explicit grant — household membership is excluded for these
   * documentTypes, see HEALTH_DOCUMENT_TYPES) before this ever runs; this layers a fresh password
   * confirmation on top, specifically for these two documentTypes, so opening an insurance card/EOB always
   * costs a step-up even for the owner's own session.
   *
   * The chapter's own "stricter logging/reauth" line means both halves — reauth alone previously left no
   * trail of who unlocked a health document and when, or of a wrong/missing password attempt against one
   * (found live via this audit: `schema.auditEvents` had zero rows for this path despite the identical
   * pattern already existing for sign-in in IdentityService.recordAuditEvent). Every outcome — success,
   * a missing password, and a wrong one — now gets its own immutable `audit_events` row.
   */
  async openHealthDocument(documentId: string, userId: string, password: string | undefined): Promise<{ url: string; title: string; documentType: string }> {
    const detail = await this.documents.documentDetail(documentId, userId); // throws if no baseline access
    if (!HEALTH_DOCUMENT_TYPES.has(detail.documentType)) {
      throw new BadRequestException({ code: "NOT_A_HEALTH_DOCUMENT", message: "This isn't a health document." });
    }
    try {
      await this.identity.verifyStepUpPassword(userId, password);
    } catch (err) {
      await this.recordHealthAccessEvent(userId, documentId, password ? "failure" : "denied");
      throw err;
    }
    await this.recordHealthAccessEvent(userId, documentId, "success");
    const url = await this.documents.signedUrl(documentId, userId);
    return { url, title: detail.title, documentType: detail.documentType };
  }

  private async recordHealthAccessEvent(userId: string, documentId: string, result: "success" | "failure" | "denied"): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: userId,
      action: "health_document.unlock",
      resourceType: "document",
      resourceId: documentId,
      result,
    });
  }

  // ---------------------------------------------------------------------------------------------------
  // "Attach an existing insurance-card/EOB document" (HLTH-001/002) — links a HEALTH_DOCUMENT_TYPES
  // document the caller owns to a health appointment they own, via `documents.linkedEntityIds`
  // (packages/db/src/schema/documents.ts) — already the schema's own generic entity-link column, so this
  // adds no migration. Deliberately many-to-many (an array, unlike tasks.healthAppointmentId's single FK
  // column above): the same insurance card plausibly applies to several appointments, unlike a one-off prep
  // task. Owner-only on both sides, same stance as linkBillToAppointment/linkTaskToAppointment. Linking
  // itself never requires the step-up password openHealthDocument does — that gate is specifically for
  // *viewing* the file's contents (minting a signed URL); recording which appointment a card applies to
  // doesn't reveal anything about the document's contents.
  // ---------------------------------------------------------------------------------------------------

  private async assertOwnedHealthDocument(documentId: string, userId: string) {
    const [doc] = await this.db
      .select({ ownerUserId: schema.documents.ownerUserId, documentType: schema.documents.documentType, linkedEntityIds: schema.documents.linkedEntityIds, deletedAt: schema.documents.deletedAt })
      .from(schema.documents)
      .where(eq(schema.documents.id, documentId))
      .limit(1);
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    if (!HEALTH_DOCUMENT_TYPES.has(doc.documentType)) {
      throw new BadRequestException({ code: "NOT_A_HEALTH_DOCUMENT", message: "This isn't an insurance-card or EOB document." });
    }
    return doc;
  }

  async linkDocumentToAppointment(documentId: string, userId: string, healthAppointmentId: string): Promise<void> {
    const doc = await this.assertOwnedHealthDocument(documentId, userId);
    await this.assertOwnedAppointment(healthAppointmentId, userId);
    if (doc.linkedEntityIds.includes(healthAppointmentId)) return; // already linked — idempotent
    await this.db
      .update(schema.documents)
      .set({ linkedEntityIds: [...doc.linkedEntityIds, healthAppointmentId], updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));
  }

  /** Detaches one appointment from a document's link list, leaving any other appointments it's linked to untouched. */
  async unlinkDocumentFromAppointment(documentId: string, userId: string, healthAppointmentId: string): Promise<void> {
    const doc = await this.assertOwnedHealthDocument(documentId, userId);
    await this.db
      .update(schema.documents)
      .set({ linkedEntityIds: doc.linkedEntityIds.filter((linkedId) => linkedId !== healthAppointmentId), updatedAt: new Date() })
      .where(eq(schema.documents.id, documentId));
  }

  // ---------------------------------------------------------------------------------------------------
  // "Export selected packet" (HLTH-001) — reuses DataExportService's JSON-manifest infrastructure rather
  // than inventing a second export mechanism, scoped to just this domain (and optionally just one
  // appointment) instead of the whole account. Returned synchronously rather than via DataExportService's
  // usual queued-job/S3/signed-URL path (RequestExportDtoSchema et al.) — that machinery exists because a
  // full-account export can be large enough to be worth a background worker; one appointment's or even one
  // user's entire health-logistics footprint (a handful of appointments/reminders/bills) is small enough to
  // just return directly, and gating it behind the same real §28.9 step-up check as everything else in this
  // module (openHealthDocument, above) matters far more here than matching the async plumbing exactly.
  // ---------------------------------------------------------------------------------------------------

  async exportHealthPacket(userId: string, password: string | undefined, appointmentId?: string | null) {
    // Ownership check before step-up, same ordering as openHealthDocument's baseline-access-then-reauth
    // sequence — never spend a step-up prompt confirming a password before finding out the appointment
    // isn't even the caller's, and never leak whether an id exists to someone re-verifying someone else's.
    if (appointmentId) await this.assertOwnedAppointment(appointmentId, userId);
    await this.identity.verifyStepUpPassword(userId, password);
    return this.dataExport.buildHealthLogisticsManifest(userId, appointmentId ?? null);
  }
}
