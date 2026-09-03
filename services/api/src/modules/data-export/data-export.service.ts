import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { OBJECT_STORAGE, type ObjectStorage } from "../documents/object-storage.interface";
import { IdentityService } from "../identity/identity.service";

const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — long enough for a real download, not indefinite

/**
 * PRIV-002 — "make user ownership operational, not merely a policy statement." Runs as a background job
 * (see worker-main.ts's dataExportWorker) since a user's full data graph can be large enough to be worth
 * not blocking the HTTP request that requested it.
 */
@Injectable()
export class DataExportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QUEUE_PRODUCER) private readonly queueProducer: QueueProducer,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async requestExport(userId: string, password: string | undefined, selectedCategories?: string[]) {
    await this.identity.verifyStepUpPassword(userId, password);
    const id = generateId("exportJob");
    // PRIV-002 "category selection" — `selectedCategories` undefined/omitted means "export everything,"
    // stored as null (not `[]`) so buildManifest's own null-check can tell "no filter" apart from "an empty
    // selection" (the Zod schema already requires at least one entry when the field is present at all, but
    // the null/undefined distinction is worth keeping explicit here rather than relying on that upstream).
    await this.db.insert(schema.exportJobs).values({ id, ownerUserId: userId, state: "queued", selectedCategories: selectedCategories ?? null });
    await this.queueProducer.enqueueDataExport({ exportJobId: id, userId, selectedCategories: selectedCategories ?? null });
    return { id, state: "queued" as const };
  }

  list(userId: string) {
    return this.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.ownerUserId, userId)).orderBy(desc(schema.exportJobs.requestedAt));
  }

  async downloadUrl(exportJobId: string, userId: string): Promise<string> {
    const [job] = await this.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, exportJobId)).limit(1);
    if (!job) throw new NotFoundException({ code: "EXPORT_NOT_FOUND", message: "Not found." });
    if (job.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your export." });
    if (job.state !== "completed" || !job.storageKey) {
      throw new NotFoundException({ code: "EXPORT_NOT_READY", message: "This export isn't ready yet." });
    }
    // `expiresAt` (set by the worker on completion, ttlMs() above) documents a 7-day retention promise —
    // found live during the backend audit: nothing anywhere actually enforced it. Without this check, a
    // signed URL to the full export (purchases, bills, calendar events, document metadata, etc.) kept
    // working indefinitely, contradicting the stated "not indefinite" retention window.
    if (job.expiresAt && job.expiresAt < new Date()) {
      throw new NotFoundException({ code: "EXPORT_EXPIRED", message: "This export has expired. Request a new one." });
    }
    return this.storage.signedGetUrl(job.storageKey, 300, `veynlo-export-${job.id}.json`);
  }

  storageKeyFor(userId: string, exportJobId: string): string {
    return `exports/${userId}/${exportJobId}.json`;
  }

  ttlMs(): number {
    return EXPORT_TTL_MS;
  }

  /**
   * The actual data-gathering half — called by worker-main.ts's dataExportWorker. Covers every
   * user-visible domain surfaced on Life/Timeline/Inbox/Settings; deliberately excludes document blob
   * bytes (a separate, much larger download the manifest points at instead via signed URLs the caller can
   * fetch on demand — see NOT_INCLUDED below), connector OAuth credentials, and other household members'
   * own private rows.
   */
  /**
   * `selectedCategories` — PRIV-002 "category selection." `null`/`undefined` (every call site before this
   * feature existed, and every call that doesn't pass it) exports every domain below exactly as before.
   * A non-null array scopes the manifest to just those keys — `EXPORT_CATEGORIES` in dto.ts is the
   * authoritative list of recognized values, kept in sync by hand with the section keys returned here.
   * Sections not gated by a category (`profile`, `householdMemberships`, `notificationPreferences`,
   * `generatedAt`/`notIncluded`) are always included — they're account-identity/metadata, not a "domain" a
   * user would think to exclude, and are small enough that gating them would add complexity with no real
   * privacy benefit (the whole export is already scoped to the requesting user's own data).
   */
  async buildManifest(userId: string, selectedCategories?: string[] | null) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });

    const wants = (category: string) => !selectedCategories || selectedCategories.includes(category);

    const purchases = wants("purchases") ? await this.db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, userId)) : [];
    const purchaseIds = purchases.map((p) => p.id);
    // purchaseLines/returnCases have no direct ownerUserId column — filter client-side by the owner's own
    // purchase ids rather than one query per purchase. shipments does have ownerUserId (added so
    // ingestion's dedup lookup can be owner-scoped — see commerce.ts), so it's queried directly, which also
    // correctly includes shipments with no linked purchase (a carrier email with no matched order number).
    const purchaseIdSet = new Set(purchaseIds);
    const allLines = purchaseIds.length ? (await this.db.select().from(schema.purchaseLines)).filter((l) => purchaseIdSet.has(l.purchaseId)) : [];
    const ownReturns = purchaseIds.length ? (await this.db.select().from(schema.returnCases)).filter((r) => purchaseIdSet.has(r.purchaseId)) : [];
    const ownShipments = purchases.length ? await this.db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, userId)) : [];

    const bills = wants("bills") ? await this.db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, userId)) : [];
    const warranties = wants("warranties") ? await this.db.select().from(schema.warranties).where(eq(schema.warranties.ownerUserId, userId)) : [];
    const recurringStreams = wants("subscriptions")
      ? await this.db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, userId))
      : [];
    const streamIds = new Set(recurringStreams.map((s) => s.id));
    const subscriptions = recurringStreams.length ? (await this.db.select().from(schema.subscriptions)).filter((s) => streamIds.has(s.recurringStreamId)) : [];
    const calendarEvents = wants("calendarEvents") ? await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId)) : [];
    const tasks = wants("tasks") ? await this.db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, userId)) : [];
    const documents = wants("documents")
      ? await this.db
          .select({
            id: schema.documents.id,
            documentType: schema.documents.documentType,
            title: schema.documents.title,
            tags: schema.documents.tags,
            createdAt: schema.documents.createdAt,
          })
          .from(schema.documents)
          .where(eq(schema.documents.ownerUserId, userId))
      : [];
    const inboxItems = wants("inboxItems") ? await this.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, userId)) : [];
    const notifications = wants("notifications") ? await this.db.select().from(schema.notifications).where(eq(schema.notifications.ownerUserId, userId)) : [];
    const [notificationPreferences] = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId))
      .limit(1);
    const memberships = await this.db
      .select({ householdId: schema.householdMemberships.householdId, role: schema.householdMemberships.role, status: schema.householdMemberships.status })
      .from(schema.householdMemberships)
      .where(eq(schema.householdMemberships.userId, userId));

    return {
      generatedAt: new Date().toISOString(),
      selectedCategories: selectedCategories ?? null,
      notIncluded: [
        "Document file contents (use the app's own download links for those)",
        "Connector OAuth credentials/tokens",
        "Other household members' own private data",
        ...(selectedCategories ? ["Domains not selected for this export (request a new export to include them)"] : []),
      ],
      profile: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        locale: user.locale,
        timezone: user.timezone,
        currency: user.currency,
        createdAt: user.createdAt,
      },
      householdMemberships: memberships,
      purchases: purchases.map((p) => ({
        ...p,
        lines: allLines.filter((l) => l.purchaseId === p.id),
        returns: ownReturns.filter((r) => r.purchaseId === p.id),
        shipments: ownShipments.filter((s) => s.purchaseId === p.id),
      })),
      bills,
      warranties,
      subscriptions: subscriptions.map((s) => ({ ...s, stream: recurringStreams.find((r) => r.id === s.recurringStreamId) })),
      calendarEvents,
      tasks,
      documents,
      inboxItems,
      notifications,
      notificationPreferences: notificationPreferences ?? null,
    };
  }

  /** PRIV-002 "size/progress" — a simple, honest count of top-level exported records across every
   * category-gated section above (each purchase counts once even though it nests lines/returns/shipments,
   * matching how a user thinks about "how many things did this export"). Called by the worker right after
   * `buildManifest` returns, on the exact object that was serialized, so the count and the file are always
   * consistent with each other. */
  itemCountOf(manifest: Awaited<ReturnType<DataExportService["buildManifest"]>>): number {
    return (
      manifest.purchases.length +
      manifest.bills.length +
      manifest.warranties.length +
      manifest.subscriptions.length +
      manifest.calendarEvents.length +
      manifest.tasks.length +
      manifest.documents.length +
      manifest.inboxItems.length +
      manifest.notifications.length
    );
  }

  /**
   * HLTH-001 "export selected packet" — a health-logistics-scoped counterpart to buildManifest above,
   * called synchronously by HealthLogisticsService.exportHealthPacket (not through the queued-job path
   * this class's other methods use — see that method's own doc comment for why). `appointmentId` null
   * exports every appointment/refill-reminder/linked-bill the caller owns; a given id scopes to just that
   * one appointment (and the bills linked to it — refill reminders have no per-appointment scope to narrow
   * to, so a single-appointment packet always reports an empty list for them, never another appointment's
   * reminders).
   */
  async buildHealthLogisticsManifest(userId: string, appointmentId: string | null) {
    const appointmentConditions = [eq(schema.healthAppointments.ownerUserId, userId), isNull(schema.healthAppointments.deletedAt)];
    if (appointmentId) appointmentConditions.push(eq(schema.healthAppointments.id, appointmentId));
    const appointments = await this.db
      .select()
      .from(schema.healthAppointments)
      .where(and(...appointmentConditions));

    const appointmentIds = appointments.map((a) => a.id);
    const linkedBills = appointmentIds.length > 0 ? await this.db.select().from(schema.bills).where(inArray(schema.bills.healthAppointmentId, appointmentIds)) : [];
    const linkedTasks = appointmentIds.length > 0 ? await this.db.select().from(schema.tasks).where(inArray(schema.tasks.healthAppointmentId, appointmentIds)) : [];

    const refillReminders = appointmentId
      ? [] // no natural per-appointment scope for a medication reminder — see this method's own doc comment
      : await this.db
          .select()
          .from(schema.refillReminders)
          .where(and(eq(schema.refillReminders.ownerUserId, userId), isNull(schema.refillReminders.petProfileId), isNull(schema.refillReminders.deletedAt)));

    return {
      generatedAt: new Date().toISOString(),
      scope: appointmentId ? ("single_appointment" as const) : ("all_health_logistics" as const),
      notIncluded: [
        "Insurance-card/EOB document file contents (open them directly in the app instead)",
        "Clinical content of any kind — this module stores none; see HealthLogisticsService's own doc comment on the non-diagnostic boundary",
      ],
      appointments,
      refillReminders,
      linkedBills,
      linkedTasks,
    };
  }
}
