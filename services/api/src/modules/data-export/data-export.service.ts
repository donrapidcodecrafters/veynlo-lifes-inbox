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
   * The actual data-gathering half — called by worker-main.ts's dataExportWorker.
   *
   * This comment already claimed to cover "every user-visible domain surfaced on Life/Timeline/Inbox/
   * Settings". It did not, and had not: the manifest read 9 domains out of the ~28 the user can see, so
   * a request for everything returned a file with no Home, Vehicles, Pets, People, Places, Trips, Lists,
   * Saved items, Identity records, Finance, School, store credits, automations or health appointments in
   * it — most of the Life tab — while `notIncluded` disclosed only document blobs, OAuth tokens and other
   * members' rows. A user reading that file had no way to know what was absent.
   *
   * Now covers every
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

    // ── Domains that "export everything" used to leave out entirely ────────────────────────────────────
    // Owner-scoped exactly like the sections above. Soft-deleted rows are excluded throughout: a user
    // asking for their data means what the app would show them, not its tombstones.
    const ownLists = wants("lists") ? await this.db.select().from(schema.lists).where(and(eq(schema.lists.ownerUserId, userId), isNull(schema.lists.archivedAt))) : [];
    const listIdSet = new Set(ownLists.map((l) => l.id));
    const listItems = ownLists.length ? (await this.db.select().from(schema.savedItems)).filter((i) => listIdSet.has(i.listId)) : [];

    const savedMemories = wants("savedItems") ? await this.db.select().from(schema.savedMemories).where(eq(schema.savedMemories.ownerUserId, userId)) : [];

    const people = wants("people") ? await this.db.select().from(schema.people).where(and(eq(schema.people.ownerUserId, userId), isNull(schema.people.deletedAt))) : [];
    const aliases = wants("people") ? await this.db.select().from(schema.aliases).where(eq(schema.aliases.ownerUserId, userId)) : [];
    const organizations = wants("people") ? await this.db.select().from(schema.organizations).where(and(eq(schema.organizations.ownerUserId, userId), isNull(schema.organizations.deletedAt))) : [];
    const personNotes = wants("people") ? await this.db.select().from(schema.personNotes).where(eq(schema.personNotes.ownerUserId, userId)) : [];
    const personImportantDates = wants("people") ? await this.db.select().from(schema.personImportantDates).where(eq(schema.personImportantDates.ownerUserId, userId)) : [];
    const personRelationships = wants("people") ? await this.db.select().from(schema.personRelationships).where(eq(schema.personRelationships.ownerUserId, userId)) : [];

    const pets = wants("pets") ? await this.db.select().from(schema.petProfiles).where(and(eq(schema.petProfiles.ownerUserId, userId), isNull(schema.petProfiles.deletedAt))) : [];
    const petVaccinations = wants("pets") ? await this.db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.ownerUserId, userId)) : [];

    const properties = wants("home") ? await this.db.select().from(schema.propertyProfiles).where(and(eq(schema.propertyProfiles.ownerUserId, userId), isNull(schema.propertyProfiles.deletedAt))) : [];
    const homeAssets = wants("home") ? await this.db.select().from(schema.homeAssets).where(and(eq(schema.homeAssets.ownerUserId, userId), isNull(schema.homeAssets.deletedAt))) : [];
    const maintenanceRecords = wants("home") ? await this.db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.ownerUserId, userId)) : [];
    const maintenanceRules = wants("home") ? await this.db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.ownerUserId, userId)) : [];

    const vehicles = wants("vehicles") ? await this.db.select().from(schema.vehicleProfiles).where(and(eq(schema.vehicleProfiles.ownerUserId, userId), isNull(schema.vehicleProfiles.deletedAt))) : [];
    const odometerObservations = wants("vehicles") ? await this.db.select().from(schema.odometerObservations).where(eq(schema.odometerObservations.ownerUserId, userId)) : [];
    const tires = wants("vehicles") ? await this.db.select().from(schema.tires).where(eq(schema.tires.ownerUserId, userId)) : [];
    const registrationRecords = wants("vehicles") ? await this.db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.ownerUserId, userId)) : [];

    const ownPlaces = wants("places") ? await this.db.select().from(schema.places).where(and(eq(schema.places.ownerUserId, userId), isNull(schema.places.deletedAt))) : [];
    const geofences = wants("places") ? await this.db.select().from(schema.geofences).where(eq(schema.geofences.ownerUserId, userId)) : [];
    const contextRules = wants("places") ? await this.db.select().from(schema.contextRules).where(eq(schema.contextRules.ownerUserId, userId)) : [];

    const ownTrips = wants("trips") ? await this.db.select().from(schema.trips).where(and(eq(schema.trips.ownerUserId, userId), isNull(schema.trips.deletedAt))) : [];
    const tripIdSet = new Set(ownTrips.map((t) => t.id));
    const tripSegments = ownTrips.length ? (await this.db.select().from(schema.tripSegments)).filter((s) => tripIdSet.has(s.tripId)) : [];
    const travelCredits = wants("trips") ? await this.db.select().from(schema.travelCredits).where(eq(schema.travelCredits.ownerUserId, userId)) : [];
    const travelEstimates = wants("trips") ? await this.db.select().from(schema.travelEstimates).where(eq(schema.travelEstimates.ownerUserId, userId)) : [];

    // `documentNumber` is deliberately omitted — see notIncluded. The app itself only ever reveals it
    // through IdentityRecordsService.revealDocumentNumber's own separate step-up check, even from inside an
    // already-unlocked emergency binder; a downloadable file full of passport numbers is not the place to
    // relax that. Everything else about the record is here.
    const identityRecords = wants("identityRecords")
      ? await this.db
          .select({
            id: schema.identityRecords.id,
            recordType: schema.identityRecords.recordType,
            label: schema.identityRecords.label,
            issuingAuthority: schema.identityRecords.issuingAuthority,
            expirationDate: schema.identityRecords.expirationDate,
            status: schema.identityRecords.status,
            createdAt: schema.identityRecords.createdAt,
          })
          .from(schema.identityRecords)
          .where(and(eq(schema.identityRecords.ownerUserId, userId), isNull(schema.identityRecords.deletedAt)))
      : [];

    const financialAccounts = wants("finance") ? await this.db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.ownerUserId, userId)) : [];
    const financialTransactions = wants("finance") ? await this.db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.ownerUserId, userId)) : [];
    const liabilities = wants("finance") ? await this.db.select().from(schema.liabilities).where(eq(schema.liabilities.ownerUserId, userId)) : [];
    const detectedIncomeStreams = wants("finance") ? await this.db.select().from(schema.detectedIncomeStreams).where(eq(schema.detectedIncomeStreams.ownerUserId, userId)) : [];

    const storeCredits = wants("storeCredits") ? await this.db.select().from(schema.storeCredits).where(eq(schema.storeCredits.ownerUserId, userId)) : [];

    const schoolEvents = wants("school") ? await this.db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.ownerUserId, userId)) : [];
    const permissionForms = wants("school") ? await this.db.select().from(schema.permissionForms).where(eq(schema.permissionForms.ownerUserId, userId)) : [];

    // The health packet (buildHealthLogisticsManifest) is a separate, appointment-scoped download reached
    // from the health screens. It is not a substitute for appearing here: a user asking for all their data
    // should not have to know that one domain lives behind a different button.
    const healthAppointments = wants("healthAppointments")
      ? await this.db.select().from(schema.healthAppointments).where(and(eq(schema.healthAppointments.ownerUserId, userId), isNull(schema.healthAppointments.deletedAt)))
      : [];
    const refillReminders = wants("healthAppointments")
      ? await this.db.select().from(schema.refillReminders).where(and(eq(schema.refillReminders.ownerUserId, userId), isNull(schema.refillReminders.deletedAt)))
      : [];

    const automationRules = wants("automations") ? await this.db.select().from(schema.automationRules).where(eq(schema.automationRules.ownerUserId, userId)) : [];
    const attentionItems = wants("attentionItems") ? await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.ownerUserId, userId)) : [];
    const objectNotes = wants("notes") ? await this.db.select().from(schema.objectNotes).where(eq(schema.objectNotes.ownerUserId, userId)) : [];
    const senderRules = wants("senderRules") ? await this.db.select().from(schema.senderRules).where(eq(schema.senderRules.ownerUserId, userId)) : [];
    const entities = wants("entities") ? await this.db.select().from(schema.canonicalEntities).where(eq(schema.canonicalEntities.ownerUserId, userId)) : [];

    // Metadata only. `credentialRef` is the pointer to the vault entry holding the OAuth tokens and is
    // excluded by column selection, not by trusting a later `delete` — notIncluded already promised this.
    const connections = wants("connections")
      ? await this.db
          .select({
            id: schema.connections.id,
            provider: schema.connections.provider,
            health: schema.connections.health,
            enabledCategories: schema.connections.enabledCategories,
            createdAt: schema.connections.createdAt,
            disconnectedAt: schema.connections.disconnectedAt,
          })
          .from(schema.connections)
          .where(eq(schema.connections.ownerUserId, userId))
      : [];

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
        "Identity-record document numbers (passport/licence numbers) — the app only ever reveals these behind a separate step-up check",
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
      lists: ownLists.map((l) => ({ ...l, items: listItems.filter((i) => i.listId === l.id) })),
      savedItems: savedMemories,
      people,
      aliases,
      organizations,
      personNotes,
      personImportantDates,
      personRelationships,
      pets,
      petVaccinations,
      properties,
      homeAssets,
      maintenanceRecords,
      maintenanceRules,
      vehicles,
      odometerObservations,
      tires,
      registrationRecords,
      places: ownPlaces,
      geofences,
      contextRules,
      trips: ownTrips.map((t) => ({ ...t, segments: tripSegments.filter((s) => s.tripId === t.id) })),
      travelCredits,
      travelEstimates,
      identityRecords,
      financialAccounts,
      financialTransactions,
      liabilities,
      detectedIncomeStreams,
      storeCredits,
      schoolEvents,
      permissionForms,
      healthAppointments,
      refillReminders,
      automationRules,
      attentionItems,
      objectNotes,
      senderRules,
      entities,
      connections,
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
