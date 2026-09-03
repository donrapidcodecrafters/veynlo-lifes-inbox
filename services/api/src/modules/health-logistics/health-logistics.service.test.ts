import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { HealthLogisticsService } from "./health-logistics.service";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { IdentityService } from "../identity/identity.service";
import { DocumentsService } from "../documents/documents.service";
import { DataExportService } from "../data-export/data-export.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";

/**
 * §27 "Health Logistics" business-logic coverage: HLTH-001 manual appointment creation, HLTH-003 refill
 * reminder create/mark-picked-up, and HLTH-004's ONE deterministic-only discrepancy rule (linking two bills
 * with different, both-non-null amounts to the same appointment flags both for review; matching amounts
 * never do). Access control itself is covered separately in health-logistics.access.test.ts.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;
const stubStorage = { putObject: async () => {}, getObject: async () => Buffer.alloc(0), signedGetUrl: async (b: string) => `https://example.com/signed/${b}` } as unknown as ObjectStorage;
const stubAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;

describe("HealthLogisticsService — business logic", () => {
  let db: Database;
  let health: HealthLogisticsService;
  let ownerUserId: string;
  let householdId: string;
  let appointmentId: string;
  const billIds: string[] = [];
  let refillReminderId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    const households = new HouseholdService(db, entitlements, noopMailer);
    const sharing = new SharingService(db);
    const identity = new IdentityService(db, stubQueue, noopMailer, stubOnboarding);
    const documents = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, households, entitlements, sharing);
    const dataExport = new DataExportService(db, stubQueue, stubStorage, identity);
    health = new HealthLogisticsService(db, households, sharing, identity, documents, dataExport);

    try {
      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `hlth-biz-${ownerUserId}@example.com`, displayName: "Owner" });
      await db.insert(schema.households).values({ id: householdId, name: "Biz Test Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping HealthLogisticsService business-logic tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
      await db.delete(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));
      await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
      await db.delete(schema.refillReminders).where(eq(schema.refillReminders.ownerUserId, ownerUserId));
      await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, ownerUserId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("createAppointment stores only logistics fields — no field exists for a diagnosis/symptom/reason-for-visit, only provider/type/when/where/prep", async () => {
    if (!dbAvailable) return;
    const { id } = await health.createAppointment(ownerUserId, {
      providerName: "Dr. Rivera",
      appointmentType: "dental",
      startIso: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      location: "123 Main St",
      prepInstructions: "Bring your insurance card",
      householdId,
    });
    appointmentId = id;
    const { appointment } = await health.appointmentDetail(id, ownerUserId);
    expect(appointment.providerName).toBe("Dr. Rivera");
    expect(appointment.appointmentType).toBe("dental");
    expect(appointment.prepInstructions).toBe("Bring your insurance card");
    expect(appointment.visibility).toBe("private"); // HLTH-001/002 "private by default"
    // The row's own keys are the exhaustive field list — asserting none of them could ever hold a
    // diagnosis/symptom/dose the way a real EMR record would (schema-level enforcement, not just prompt).
    expect(Object.keys(appointment).sort()).toEqual(
      [
        "appointmentType",
        "confidenceBand",
        "createdAt",
        "dateTime",
        "dateTimeSort",
        "deletedAt",
        "householdId",
        "id",
        "location",
        "ownerUserId",
        "prepInstructions",
        "providerName",
        "source",
        "sourceEventId",
        "status",
        "updatedAt",
        "visibility",
      ].sort(),
    );
  });

  it("createRefillReminder has no dose/frequency field at all — only a plain medication label, a date, and an optional pharmacy", async () => {
    if (!dbAvailable) return;
    const { id } = await health.createRefillReminder(ownerUserId, {
      medicationName: "Amoxicillin",
      nextRefillIso: "2026-10-15",
      pharmacy: "CVS on Main St",
      householdId,
    });
    refillReminderId = id;
    const reminders = await health.listRefillReminders(ownerUserId);
    const reminder = reminders.find((r) => r.id === id);
    expect(reminder?.medicationName).toBe("Amoxicillin");
    expect(reminder?.pharmacy).toBe("CVS on Main St");
    expect(reminder?.pickedUpAt).toBeNull();
  });

  it("markRefillPickedUp sets pickedUpAt, and a picked-up reminder no longer needs a review", async () => {
    if (!dbAvailable) return;
    await health.markRefillPickedUp(refillReminderId, ownerUserId);
    const reminders = await health.listRefillReminders(ownerUserId);
    const reminder = reminders.find((r) => r.id === refillReminderId);
    expect(reminder?.pickedUpAt).not.toBeNull();
  });

  it("deleteRefillReminder soft-deletes — it stops appearing in listRefillReminders", async () => {
    if (!dbAvailable) return;
    const { id } = await health.createRefillReminder(ownerUserId, { medicationName: "Temp med", nextRefillIso: "2026-11-01" });
    await health.deleteRefillReminder(id, ownerUserId);
    const reminders = await health.listRefillReminders(ownerUserId);
    expect(reminders.map((r) => r.id)).not.toContain(id);
  });

  it("linkBillToAppointment: matching amounts never trigger a review flag", async () => {
    if (!dbAvailable) return;
    const billA = generateId("bill");
    const billB = generateId("bill");
    billIds.push(billA, billB);
    await db.insert(schema.bills).values([
      { id: billA, ownerUserId, billerLabel: "Dr. Rivera Dental", amountDueMinorUnits: 15000, amountDueCurrency: "USD", dueDate: { precision: "date", instantUtc: null, date: "2026-10-01", timezone: null, sourceText: null } },
      { id: billB, ownerUserId, billerLabel: "Insurer EOB", amountDueMinorUnits: 15000, amountDueCurrency: "USD", dueDate: { precision: "date", instantUtc: null, date: "2026-10-05", timezone: null, sourceText: null } },
    ]);
    const first = await health.linkBillToAppointment(billA, ownerUserId, appointmentId);
    expect(first.needsAmountReview).toBe(false);
    const second = await health.linkBillToAppointment(billB, ownerUserId, appointmentId);
    expect(second.needsAmountReview).toBe(false);
    const [rowA] = await db.select({ needsAmountReview: schema.bills.needsAmountReview }).from(schema.bills).where(eq(schema.bills.id, billA));
    const [rowB] = await db.select({ needsAmountReview: schema.bills.needsAmountReview }).from(schema.bills).where(eq(schema.bills.id, billB));
    expect(rowA?.needsAmountReview).toBe(false);
    expect(rowB?.needsAmountReview).toBe(false);
  });

  it("linkBillToAppointment: two DIFFERENT non-null amounts on the same appointment flag BOTH bills for review — deterministic only, never an inferred 'this is an error'", async () => {
    if (!dbAvailable) return;
    const apptId2 = generateId("healthAppointment");
    await db.insert(schema.healthAppointments).values({
      id: apptId2,
      ownerUserId,
      dateTime: { precision: "instant", instantUtc: new Date().toISOString(), date: null, timezone: null, sourceText: null },
      source: "manual",
    });
    const billC = generateId("bill");
    const billD = generateId("bill");
    billIds.push(billC, billD);
    await db.insert(schema.bills).values([
      { id: billC, ownerUserId, billerLabel: "Provider bill", amountDueMinorUnits: 20000, amountDueCurrency: "USD", dueDate: { precision: "date", instantUtc: null, date: "2026-10-01", timezone: null, sourceText: null } },
      { id: billD, ownerUserId, billerLabel: "EOB — different amount", amountDueMinorUnits: 12500, amountDueCurrency: "USD", dueDate: { precision: "date", instantUtc: null, date: "2026-10-05", timezone: null, sourceText: null } },
    ]);
    await health.linkBillToAppointment(billC, ownerUserId, apptId2);
    const result = await health.linkBillToAppointment(billD, ownerUserId, apptId2);
    expect(result.needsAmountReview).toBe(true);
    const [rowC] = await db.select({ needsAmountReview: schema.bills.needsAmountReview }).from(schema.bills).where(eq(schema.bills.id, billC));
    expect(rowC?.needsAmountReview).toBe(true); // the sibling bill also gets flagged, not just the one just linked

    await health.clearBillAmountReview(billC, ownerUserId);
    const [rowCCleared] = await db.select({ needsAmountReview: schema.bills.needsAmountReview }).from(schema.bills).where(eq(schema.bills.id, billC));
    expect(rowCCleared?.needsAmountReview).toBe(false);

    await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.id, apptId2));
  });

  it("linkBillToAppointment rejects linking someone else's bill or someone else's appointment", async () => {
    if (!dbAvailable) return;
    const strangerId = generateId("user");
    await db.insert(schema.users).values({ id: strangerId, email: `hlth-stranger-${strangerId}@example.com`, displayName: "Stranger" });
    const strangerBill = generateId("bill");
    await db.insert(schema.bills).values({ id: strangerBill, ownerUserId: strangerId, billerLabel: "Not yours", dueDate: { precision: "date", instantUtc: null, date: "2026-10-01", timezone: null, sourceText: null } });
    await expect(health.linkBillToAppointment(strangerBill, ownerUserId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await db.delete(schema.bills).where(eq(schema.bills.id, strangerBill));
    await db.delete(schema.users).where(eq(schema.users.id, strangerId));
  });

  // -------------------------------------------------------------------------------------------------
  // HLTH-001 "forms/tasks" linkage — found live via a spec-retraceability audit: bills could be linked to
  // an appointment (above), but nothing could ever set tasks.healthAppointmentId; no backend mechanism, no
  // UI. Mirrors the linkBillToAppointment test shape exactly.
  // -------------------------------------------------------------------------------------------------

  it("linkTaskToAppointment attaches an existing task, surfaced via appointmentDetail's linkedTasks; unlinkTaskFromAppointment detaches it again", async () => {
    if (!dbAvailable) return;
    const taskId = generateId("task");
    await db.insert(schema.tasks).values({ id: taskId, ownerUserId, title: "Bring insurance card" });

    await health.linkTaskToAppointment(taskId, ownerUserId, appointmentId);
    const { linkedTasks } = await health.appointmentDetail(appointmentId, ownerUserId);
    expect(linkedTasks.map((t) => t.id)).toContain(taskId);
    const [row] = await db.select({ healthAppointmentId: schema.tasks.healthAppointmentId }).from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(row?.healthAppointmentId).toBe(appointmentId);

    await health.unlinkTaskFromAppointment(taskId, ownerUserId);
    const afterUnlink = await health.appointmentDetail(appointmentId, ownerUserId);
    expect(afterUnlink.linkedTasks.map((t) => t.id)).not.toContain(taskId);

    await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
  });

  it("linkTaskToAppointment rejects linking someone else's task or to someone else's appointment", async () => {
    if (!dbAvailable) return;
    const strangerId = generateId("user");
    await db.insert(schema.users).values({ id: strangerId, email: `hlth-task-stranger-${strangerId}@example.com`, displayName: "Stranger" });
    const strangerTask = generateId("task");
    await db.insert(schema.tasks).values({ id: strangerTask, ownerUserId: strangerId, title: "Not yours" });
    await expect(health.linkTaskToAppointment(strangerTask, ownerUserId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });

    const ownTask = generateId("task");
    await db.insert(schema.tasks).values({ id: ownTask, ownerUserId, title: "My task" });
    await expect(health.linkTaskToAppointment(ownTask, strangerId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });

    await db.delete(schema.tasks).where(eq(schema.tasks.id, strangerTask));
    await db.delete(schema.tasks).where(eq(schema.tasks.id, ownTask));
    await db.delete(schema.users).where(eq(schema.users.id, strangerId));
  });

  // -------------------------------------------------------------------------------------------------
  // HLTH-001/002 "attach form/card/bill" — insurance-card/EOB document linking, via documents.linkedEntityIds.
  // -------------------------------------------------------------------------------------------------

  it("linkDocumentToAppointment attaches an insurance-card document, idempotently, and rejects a non-health documentType", async () => {
    if (!dbAvailable) return;
    const cardId = generateId("document");
    await db.insert(schema.documents).values({ id: cardId, ownerUserId, documentType: "insurance_card", title: "My card", tags: [] });

    await health.linkDocumentToAppointment(cardId, ownerUserId, appointmentId);
    const { linkedDocuments } = await health.appointmentDetail(appointmentId, ownerUserId);
    expect(linkedDocuments.map((d) => d.id)).toContain(cardId);

    // Linking again is a no-op, not a duplicate entry.
    await health.linkDocumentToAppointment(cardId, ownerUserId, appointmentId);
    const [row] = await db.select({ linkedEntityIds: schema.documents.linkedEntityIds }).from(schema.documents).where(eq(schema.documents.id, cardId));
    expect(row?.linkedEntityIds.filter((linkedId) => linkedId === appointmentId)).toHaveLength(1);

    await health.unlinkDocumentFromAppointment(cardId, ownerUserId, appointmentId);
    const afterUnlink = await health.appointmentDetail(appointmentId, ownerUserId);
    expect(afterUnlink.linkedDocuments.map((d) => d.id)).not.toContain(cardId);

    const receiptId = generateId("document");
    await db.insert(schema.documents).values({ id: receiptId, ownerUserId, documentType: "receipt", title: "Not a health doc", tags: [] });
    await expect(health.linkDocumentToAppointment(receiptId, ownerUserId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_A_HEALTH_DOCUMENT" } });

    await db.delete(schema.documents).where(eq(schema.documents.id, cardId));
    await db.delete(schema.documents).where(eq(schema.documents.id, receiptId));
  });

  it("linkDocumentToAppointment rejects linking someone else's document or to someone else's appointment", async () => {
    if (!dbAvailable) return;
    const strangerId = generateId("user");
    await db.insert(schema.users).values({ id: strangerId, email: `hlth-doc-stranger-${strangerId}@example.com`, displayName: "Stranger" });
    const strangerDoc = generateId("document");
    await db.insert(schema.documents).values({ id: strangerDoc, ownerUserId: strangerId, documentType: "insurance_card", title: "Not yours", tags: [] });
    await expect(health.linkDocumentToAppointment(strangerDoc, ownerUserId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });

    const ownDoc = generateId("document");
    await db.insert(schema.documents).values({ id: ownDoc, ownerUserId, documentType: "eob", title: "My EOB", tags: [] });
    await expect(health.linkDocumentToAppointment(ownDoc, strangerId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });

    await db.delete(schema.documents).where(eq(schema.documents.id, strangerDoc));
    await db.delete(schema.documents).where(eq(schema.documents.id, ownDoc));
    await db.delete(schema.users).where(eq(schema.users.id, strangerId));
  });

  // -------------------------------------------------------------------------------------------------
  // HLTH-001 "export selected packet" — step-up-gated, reuses DataExportService's manifest infrastructure.
  // -------------------------------------------------------------------------------------------------

  it("exportHealthPacket requires the §28.9 step-up password, same PASSWORD_REQUIRED/INVALID_CREDENTIALS shape as openHealthDocument", async () => {
    if (!dbAvailable) return;
    const argon2 = await import("argon2");
    const passwordHash = await argon2.hash("export packet password");
    await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, ownerUserId));

    await expect(health.exportHealthPacket(ownerUserId, undefined, null)).rejects.toMatchObject({ response: { code: "PASSWORD_REQUIRED" } });
    await expect(health.exportHealthPacket(ownerUserId, "wrong password", null)).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
    const manifest = await health.exportHealthPacket(ownerUserId, "export packet password", null);
    expect(manifest.scope).toBe("all_health_logistics");
    expect(manifest.appointments.map((a) => a.id)).toContain(appointmentId);

    await db.update(schema.users).set({ passwordHash: null }).where(eq(schema.users.id, ownerUserId));
  });

  it("exportHealthPacket scoped to one appointment returns only that appointment (and its linked bills), never another appointment's refill reminders", async () => {
    if (!dbAvailable) return;
    const manifest = await health.exportHealthPacket(ownerUserId, undefined, appointmentId);
    expect(manifest.scope).toBe("single_appointment");
    expect(manifest.appointments.map((a) => a.id)).toEqual([appointmentId]);
    expect(manifest.refillReminders).toEqual([]); // no per-appointment scope for a medication reminder
    expect(manifest.linkedBills.every((b) => b.healthAppointmentId === appointmentId)).toBe(true);
  });

  it("exportHealthPacket rejects exporting someone else's appointment", async () => {
    if (!dbAvailable) return;
    const strangerId = generateId("user");
    await db.insert(schema.users).values({ id: strangerId, email: `hlth-export-stranger-${strangerId}@example.com`, displayName: "Stranger" });
    await expect(health.exportHealthPacket(strangerId, undefined, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await db.delete(schema.users).where(eq(schema.users.id, strangerId));
  });

  // -------------------------------------------------------------------------------------------------
  // AI-001 "Evidence-backed fact creation" — found live via a spec-retraceability audit:
  // healthAppointments.sourceEventId was populated by IngestionService.extractHealthAppointment, but
  // appointmentDetail never read it back, so a discovered appointment had no "why am I seeing this?" trail
  // anywhere (unlike CommerceService's purchases/bills/subscriptions/etc., which all expose an `evidence`
  // field). Mirrors CommerceService.evidenceForSourceEvent exactly.
  // -------------------------------------------------------------------------------------------------

  it("appointmentDetail returns evidence for a discovered appointment's sourceEventId, and null for a manually-entered one with no source", async () => {
    if (!dbAvailable) return;
    const manual = await health.appointmentDetail(appointmentId, ownerUserId);
    expect(manual.evidence).toBeNull(); // the "createAppointment" test above made this one manually, with no sourceEventId

    const sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email_message",
      contentHash: "evidence-test-hash",
      occurredAt: new Date("2026-09-01T12:00:00Z"),
      subjectLine: "Your appointment with Dr. Rivera is confirmed",
      snippet: "Your dental cleaning is confirmed for October 1st at 123 Main St.",
      fromAddress: "no-reply@drrivera.example.com",
      idempotencyKey: `evidence-test-${sourceEventId}`,
    });
    const discoveredId = generateId("healthAppointment");
    await db.insert(schema.healthAppointments).values({
      id: discoveredId,
      ownerUserId,
      dateTime: { precision: "instant", instantUtc: new Date().toISOString(), date: null, timezone: null, sourceText: null },
      source: "discovered_from_evidence",
      sourceEventId,
      confidenceBand: "high",
    });

    const { evidence } = await health.appointmentDetail(discoveredId, ownerUserId);
    expect(evidence).not.toBeNull();
    expect(evidence?.sourceEventId).toBe(sourceEventId);
    expect(evidence?.subjectLine).toBe("Your appointment with Dr. Rivera is confirmed");
    expect(evidence?.snippet).toBe("Your dental cleaning is confirmed for October 1st at 123 Main St.");
    expect(evidence?.fromAddress).toBe("no-reply@drrivera.example.com");
    expect(evidence?.kind).toBe("email_message");

    await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.id, discoveredId));
    await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId));
  });
});
