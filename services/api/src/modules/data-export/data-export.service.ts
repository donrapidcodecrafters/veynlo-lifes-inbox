import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { StorageService } from "../documents/storage.service";

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
    private readonly queueProducer: QueueProducerService,
    private readonly storage: StorageService,
  ) {}

  async requestExport(userId: string) {
    const id = generateId("exportJob");
    await this.db.insert(schema.exportJobs).values({ id, ownerUserId: userId, state: "queued" });
    await this.queueProducer.enqueueDataExport({ exportJobId: id, userId });
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
    return this.storage.signedGetUrl(job.storageKey, 300);
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
  async buildManifest(userId: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });

    const purchases = await this.db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, userId));
    const purchaseIds = purchases.map((p) => p.id);
    // purchaseLines/returnCases/shipments have no direct ownerUserId column — filter client-side by the
    // owner's own purchase ids rather than one query per purchase.
    const purchaseIdSet = new Set(purchaseIds);
    const allLines = purchaseIds.length ? (await this.db.select().from(schema.purchaseLines)).filter((l) => purchaseIdSet.has(l.purchaseId)) : [];
    const ownReturns = purchaseIds.length ? (await this.db.select().from(schema.returnCases)).filter((r) => purchaseIdSet.has(r.purchaseId)) : [];
    const ownShipments = purchaseIds.length
      ? (await this.db.select().from(schema.shipments)).filter((s) => s.purchaseId && purchaseIdSet.has(s.purchaseId))
      : [];

    const bills = await this.db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, userId));
    const warranties = await this.db.select().from(schema.warranties).where(eq(schema.warranties.ownerUserId, userId));
    const recurringStreams = await this.db.select().from(schema.recurringStreams).where(eq(schema.recurringStreams.ownerUserId, userId));
    const streamIds = new Set(recurringStreams.map((s) => s.id));
    const subscriptions = (await this.db.select().from(schema.subscriptions)).filter((s) => streamIds.has(s.recurringStreamId));
    const calendarEvents = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId));
    const tasks = await this.db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, userId));
    const documents = await this.db
      .select({
        id: schema.documents.id,
        documentType: schema.documents.documentType,
        title: schema.documents.title,
        tags: schema.documents.tags,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(eq(schema.documents.ownerUserId, userId));
    const inboxItems = await this.db.select().from(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, userId));
    const notifications = await this.db.select().from(schema.notifications).where(eq(schema.notifications.ownerUserId, userId));
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
      notIncluded: [
        "Document file contents (use the app's own download links for those)",
        "Connector OAuth credentials/tokens",
        "Other household members' own private data",
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
}
