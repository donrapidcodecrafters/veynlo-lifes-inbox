import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
 * §27 "Health Logistics (Non-Diagnostic)" — the adversarial access-control matrix HealthLogisticsService's
 * own doc comment promises: unlike every other domain in this app (Schedule/Commerce/Documents/Lists),
 * plain active household membership must NEVER by itself grant visibility into another member's
 * appointment or refill reminder. Mirrors documents.household-membership.test.ts's "does a plain member see
 * it" shape, but inverted — here the correct answer for a plain member is "no," and only an explicit
 * "health:read" delegation (on a row the owner has additionally marked visibility:"household") or a direct
 * resourceGrant should ever open the door. Also exercises the parallel HLTH-002 half: a health-tagged
 * document stays inaccessible to a plain household member and to a caregiver delegate with only
 * "documents:read" (not "health:read"), and always demands step-up re-authentication even for the owner.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;
const stubStorage = {
  putObject: async () => {},
  getObject: async () => Buffer.alloc(0),
  signedGetUrl: async (blobRef: string) => `https://example.com/signed/${blobRef}`,
} as unknown as ObjectStorage;
const stubAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;

describe("HealthLogisticsService — private-by-default access control", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let identity: IdentityService;
  let documents: DocumentsService;
  let entitlements: EntitlementsService;
  let health: HealthLogisticsService;

  let ownerUserId: string;
  let plainMemberUserId: string; // active household member, NO delegation
  let caregiverUserId: string; // holds an explicit "health:read" delegation
  let documentsOnlyCaregiverUserId: string; // holds "documents:read" but NOT "health:read"
  let granteeUserId: string; // holds a direct resourceGrant on one specific appointment
  let outsiderUserId: string; // no membership, no delegation, no grant
  let householdId: string;
  let appointmentId: string; // stays visibility:"private"
  let householdVisibleAppointmentId: string; // owner explicitly sets visibility:"household"
  let refillReminderId: string;
  let insuranceDocumentId: string;
  const OWNER_PASSWORD = "correct horse battery staple health";
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    identity = new IdentityService(db, stubQueue, noopMailer, stubOnboarding);
    documents = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, households, entitlements, sharing);
    const dataExport = new DataExportService(db, stubQueue, stubStorage, identity);
    health = new HealthLogisticsService(db, households, sharing, identity, documents, dataExport);

    try {
      const argon2 = await import("argon2");
      ownerUserId = generateId("user");
      plainMemberUserId = generateId("user");
      caregiverUserId = generateId("user");
      documentsOnlyCaregiverUserId = generateId("user");
      granteeUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");

      const ownerPasswordHash = await argon2.hash(OWNER_PASSWORD);
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `hlth-owner-${ownerUserId}@example.com`, displayName: "Owner", passwordHash: ownerPasswordHash },
        { id: plainMemberUserId, email: `hlth-member-${plainMemberUserId}@example.com`, displayName: "Plain Member" },
        { id: caregiverUserId, email: `hlth-caregiver-${caregiverUserId}@example.com`, displayName: "Caregiver" },
        { id: documentsOnlyCaregiverUserId, email: `hlth-docs-only-${documentsOnlyCaregiverUserId}@example.com`, displayName: "Docs-Only Caregiver" },
        { id: granteeUserId, email: `hlth-grantee-${granteeUserId}@example.com`, displayName: "Grantee" },
        { id: outsiderUserId, email: `hlth-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Health Test Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: plainMemberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: caregiverUserId, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: documentsOnlyCaregiverUserId, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
      // Explicit, scoped opt-in grants — never implied by membership alone (FAM-006).
      await db.insert(schema.caregiverDelegations).values([
        { id: generateId("caregiverDelegation"), householdId, delegateUserId: caregiverUserId, grantedByUserId: ownerUserId, scopes: ["health:read"] },
        { id: generateId("caregiverDelegation"), householdId, delegateUserId: documentsOnlyCaregiverUserId, grantedByUserId: ownerUserId, scopes: ["documents:read"] },
      ]);

      appointmentId = generateId("healthAppointment");
      await db.insert(schema.healthAppointments).values({
        id: appointmentId,
        ownerUserId,
        householdId,
        visibility: "private",
        providerName: "Dr. Smith",
        appointmentType: "primary care",
        dateTime: { precision: "instant", instantUtc: new Date(Date.now() + 86_400_000).toISOString(), date: null, timezone: null, sourceText: null },
        dateTimeSort: new Date(Date.now() + 86_400_000),
        source: "manual",
      });

      householdVisibleAppointmentId = generateId("healthAppointment");
      await db.insert(schema.healthAppointments).values({
        id: householdVisibleAppointmentId,
        ownerUserId,
        householdId,
        visibility: "household",
        providerName: "Dr. Jones",
        appointmentType: "dental",
        dateTime: { precision: "instant", instantUtc: new Date(Date.now() + 172_800_000).toISOString(), date: null, timezone: null, sourceText: null },
        dateTimeSort: new Date(Date.now() + 172_800_000),
        source: "manual",
      });

      refillReminderId = generateId("refillReminder");
      await db.insert(schema.refillReminders).values({
        id: refillReminderId,
        ownerUserId,
        householdId,
        petProfileId: null,
        medicationName: "Lisinopril",
        nextRefillDate: { precision: "date", instantUtc: null, date: "2026-10-01", timezone: null, sourceText: null },
        nextRefillDateSort: new Date("2026-10-01T00:00:00Z"),
      });

      const versionId = generateId("documentVersion");
      insuranceDocumentId = generateId("document");
      await db.insert(schema.documents).values({
        id: insuranceDocumentId,
        ownerUserId,
        householdId,
        documentType: "insurance_card",
        title: "Health insurance card",
        sensitivity: "highly_sensitive",
        visibility: "household", // even explicitly shared with the household, HEALTH_DOCUMENT_TYPES must still block plain membership access
        tags: [],
        currentVersionId: versionId,
      });
      await db.insert(schema.documentVersions).values({
        id: versionId,
        documentId: insuranceDocumentId,
        blobRef: `documents/${insuranceDocumentId}/v1.pdf`,
        contentHash: "test-hash",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping HealthLogisticsService access-control tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.documentVersions).where(eq(schema.documentVersions.documentId, insuranceDocumentId));
      await db.delete(schema.documents).where(eq(schema.documents.id, insuranceDocumentId));
      await db.delete(schema.refillReminders).where(eq(schema.refillReminders.id, refillReminderId));
      await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.householdId, householdId));
      await db.delete(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.householdId, householdId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      for (const id of [ownerUserId, plainMemberUserId, caregiverUserId, documentsOnlyCaregiverUserId, granteeUserId, outsiderUserId]) {
        await db.delete(schema.users).where(eq(schema.users.id, id));
      }
    }
  });

  it("the owner always sees their own appointment and refill reminder", async () => {
    if (!dbAvailable) return;
    const appts = await health.listAppointments(ownerUserId);
    expect(appts.map((a) => a.id)).toEqual(expect.arrayContaining([appointmentId, householdVisibleAppointmentId]));
    const reminders = await health.listRefillReminders(ownerUserId);
    expect(reminders.map((r) => r.id)).toContain(refillReminderId);
  });

  it("a plain active household member (no delegation) does NOT see a private appointment, even though the exact same household-visibility shape grants them access to ordinary shared documents/lists elsewhere in this app", async () => {
    if (!dbAvailable) return;
    const appts = await health.listAppointments(plainMemberUserId);
    expect(appts.map((a) => a.id)).not.toContain(appointmentId);
    await expect(health.appointmentDetail(appointmentId, plainMemberUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });

  it("a plain active household member does NOT see the appointment even once the owner marks it visibility:'household' — plain membership alone must never be enough for health data", async () => {
    if (!dbAvailable) return;
    const appts = await health.listAppointments(plainMemberUserId);
    expect(appts.map((a) => a.id)).not.toContain(householdVisibleAppointmentId);
    await expect(health.appointmentDetail(householdVisibleAppointmentId, plainMemberUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });

  it("a plain active household member does NOT see another member's refill reminder", async () => {
    if (!dbAvailable) return;
    const reminders = await health.listRefillReminders(plainMemberUserId);
    expect(reminders.map((r) => r.id)).not.toContain(refillReminderId);
  });

  it("a caregiver with an explicit 'health:read' delegation sees the household-visible appointment, but still NOT the still-private one", async () => {
    if (!dbAvailable) return;
    const appts = await health.listAppointments(caregiverUserId);
    expect(appts.map((a) => a.id)).toContain(householdVisibleAppointmentId);
    expect(appts.map((a) => a.id)).not.toContain(appointmentId);
    const detail = await health.appointmentDetail(householdVisibleAppointmentId, caregiverUserId);
    expect(detail.appointment.id).toBe(householdVisibleAppointmentId);
    await expect(health.appointmentDetail(appointmentId, caregiverUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });

  it("a caregiver with only 'documents:read' (not 'health:read') sees NOTHING in health-logistics — delegation scopes are not fungible", async () => {
    if (!dbAvailable) return;
    const appts = await health.listAppointments(documentsOnlyCaregiverUserId);
    expect(appts.map((a) => a.id)).not.toContain(householdVisibleAppointmentId);
    expect(appts.map((a) => a.id)).not.toContain(appointmentId);
  });

  it("setAppointmentVisibility rejects a non-owner, and requires a household before allowing 'household' visibility", async () => {
    if (!dbAvailable) return;
    await expect(health.setAppointmentVisibility(appointmentId, plainMemberUserId, "household")).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });

    const soloApptId = generateId("healthAppointment");
    await db.insert(schema.healthAppointments).values({
      id: soloApptId,
      ownerUserId,
      householdId: null,
      visibility: "private",
      dateTime: { precision: "instant", instantUtc: new Date().toISOString(), date: null, timezone: null, sourceText: null },
      source: "manual",
    });
    await expect(health.setAppointmentVisibility(soloApptId, ownerUserId, "household")).rejects.toMatchObject({ response: { code: "HOUSEHOLD_REQUIRED" } });
    await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.id, soloApptId));
  });

  it("an explicit resourceGrant recipient sees exactly the one appointment shared with them, and nothing else — HLTH-005 'granular ... avoid blanket medical history access'", async () => {
    if (!dbAvailable) return;
    await health.createAppointmentGrant(appointmentId, ownerUserId, `hlth-grantee-${granteeUserId}@example.com`);
    const appts = await health.listAppointments(granteeUserId);
    expect(appts.map((a) => a.id)).toContain(appointmentId);
    // The grant is scoped to ONE row — the grantee must not also see the other, ungranted appointment.
    expect(appts.map((a) => a.id)).not.toContain(householdVisibleAppointmentId);
  });

  it("an outsider (no membership, no delegation, no grant) is fully blocked", async () => {
    if (!dbAvailable) return;
    const appts = await health.listAppointments(outsiderUserId);
    expect(appts.map((a) => a.id)).not.toContain(appointmentId);
    expect(appts.map((a) => a.id)).not.toContain(householdVisibleAppointmentId);
    await expect(health.appointmentDetail(appointmentId, outsiderUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    const reminders = await health.listRefillReminders(outsiderUserId);
    expect(reminders.map((r) => r.id)).not.toContain(refillReminderId);
  });

  it("public share links are unconditionally disabled for health-logistics resources, even for the owner", async () => {
    if (!dbAvailable) return;
    await expect(health.createAppointmentShareLink(appointmentId, ownerUserId)).rejects.toMatchObject({ response: { code: "PUBLIC_LINKS_DISABLED_FOR_HEALTH" } });
    // Non-owner still gets rejected for not owning it, never leaking whether public links exist for this resource.
    await expect(health.createAppointmentShareLink(appointmentId, outsiderUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });

  it("HLTH-002: a plain household member cannot open the insurance-card document even though it's explicitly visibility:'household' — the same shape that WOULD grant them access to an ordinary shared document", async () => {
    if (!dbAvailable) return;
    await expect(documents.signedUrl(insuranceDocumentId, plainMemberUserId)).rejects.toThrow();
    await expect(health.openHealthDocument(insuranceDocumentId, plainMemberUserId, undefined)).rejects.toThrow();
  });

  it("HLTH-002: the owner themself must still pass step-up re-authentication to open the insurance-card document", async () => {
    if (!dbAvailable) return;
    await expect(health.openHealthDocument(insuranceDocumentId, ownerUserId, undefined)).rejects.toMatchObject({ response: { code: "PASSWORD_REQUIRED" } });
    await expect(health.openHealthDocument(insuranceDocumentId, ownerUserId, "definitely wrong")).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
    const opened = await health.openHealthDocument(insuranceDocumentId, ownerUserId, OWNER_PASSWORD);
    expect(opened.documentType).toBe("insurance_card");
    expect(opened.url).toContain(insuranceDocumentId);
  });

  it("HLTH-002: openHealthDocument writes an audit_events row for every outcome — denied (no password), failure (wrong password), and success — since 'stricter logging/reauth' means both halves", async () => {
    if (!dbAvailable) return;
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.resourceId, insuranceDocumentId));

    await expect(health.openHealthDocument(insuranceDocumentId, ownerUserId, undefined)).rejects.toMatchObject({ response: { code: "PASSWORD_REQUIRED" } });
    await expect(health.openHealthDocument(insuranceDocumentId, ownerUserId, "definitely wrong")).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
    await health.openHealthDocument(insuranceDocumentId, ownerUserId, OWNER_PASSWORD);

    const events = await db
      .select({ action: schema.auditEvents.action, result: schema.auditEvents.result, actorId: schema.auditEvents.actorId })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.resourceId, insuranceDocumentId));
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.action === "health_document.unlock" && e.actorId === ownerUserId)).toBe(true);
    expect(events.map((e) => e.result).sort()).toEqual(["denied", "failure", "success"]);

    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.resourceId, insuranceDocumentId));
  });

  it("HLTH-005: a 'health:read' delegation stops granting access immediately after the delegate leaves the household — mirrors household.delegation-post-leave.test.ts's FAM-006 pattern, exercised at this module's own boundary rather than only at the shared HouseholdService.delegatedHouseholdIds helper", async () => {
    if (!dbAvailable) return;
    // caregiverUserId already holds an unexpired, unrevoked "health:read" delegation on householdId (set
    // up in beforeAll) and is still an active member at this point in the suite — confirm access still
    // works before leaving, exactly like the household-level test's "whileMember" assertion.
    const whileMember = await health.listAppointments(caregiverUserId);
    expect(whileMember.map((a) => a.id)).toContain(householdVisibleAppointmentId);
    await expect(health.appointmentDetail(householdVisibleAppointmentId, caregiverUserId)).resolves.toHaveProperty("appointment.id", householdVisibleAppointmentId);

    await households.leave(householdId, caregiverUserId);

    const afterLeaving = await health.listAppointments(caregiverUserId);
    expect(afterLeaving.map((a) => a.id)).not.toContain(householdVisibleAppointmentId);
    await expect(health.appointmentDetail(householdVisibleAppointmentId, caregiverUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    const remindersAfterLeaving = await health.listRefillReminders(caregiverUserId);
    expect(remindersAfterLeaving.map((r) => r.id)).not.toContain(refillReminderId);

    // Sanity, same as the household-level test: the delegation row itself is untouched — this is a
    // read-time filter by current membership, not a mutation of the delegation.
    const [delegation] = await db.select().from(schema.caregiverDelegations).where(and(eq(schema.caregiverDelegations.householdId, householdId), eq(schema.caregiverDelegations.delegateUserId, caregiverUserId))).limit(1);
    expect(delegation).toBeDefined();
    expect(delegation!.revokedAt).toBeNull();

    // Restore membership so the rest of the suite (which still exercises caregiverUserId as an active
    // delegate) is unaffected by running after this test.
    await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: caregiverUserId, role: "adult_member", status: "active", joinedAt: new Date() });
  });

  it("openHealthDocument rejects a non-health document type even for its owner", async () => {
    if (!dbAvailable) return;
    const versionId = generateId("documentVersion");
    const ordinaryDocId = generateId("document");
    await db.insert(schema.documents).values({
      id: ordinaryDocId,
      ownerUserId,
      documentType: "receipt",
      title: "Just a receipt",
      tags: [],
      currentVersionId: versionId,
    });
    await db.insert(schema.documentVersions).values({
      id: versionId,
      documentId: ordinaryDocId,
      blobRef: `documents/${ordinaryDocId}/v1.pdf`,
      contentHash: "test-hash-2",
      mimeType: "application/pdf",
      sizeBytes: 10,
    });
    await expect(health.openHealthDocument(ordinaryDocId, ownerUserId, OWNER_PASSWORD)).rejects.toMatchObject({ response: { code: "NOT_A_HEALTH_DOCUMENT" } });
    await db.delete(schema.documentVersions).where(eq(schema.documentVersions.documentId, ordinaryDocId));
    await db.delete(schema.documents).where(eq(schema.documents.id, ordinaryDocId));
  });

  /**
   * HLTH-001 new-surface adversarial coverage: linking a task/document, and exporting a packet, must obey
   * exactly the same private-by-default rule as reading an appointment — NEITHER plain household membership
   * NOR a "health:read" delegation (which only ever grants READ of a household-visible row, see
   * appointmentAccessCondition) is enough to let anyone but the owner attach something to, or export,
   * someone else's appointment. A plain member/outsider must see a 403, never a leak of whether the
   * appointment exists to them.
   */
  it("a plain household member, a 'health:read' delegate, and an outsider can NOT link a task to another member's appointment, even the household-visible one", async () => {
    if (!dbAvailable) return;
    const memberTaskId = generateId("task");
    await db.insert(schema.tasks).values({ id: memberTaskId, ownerUserId: plainMemberUserId, title: "Plain member's own task" });

    for (const actorId of [plainMemberUserId, caregiverUserId, outsiderUserId]) {
      await expect(health.linkTaskToAppointment(memberTaskId, actorId, householdVisibleAppointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
      await expect(health.linkTaskToAppointment(memberTaskId, actorId, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    }

    await db.delete(schema.tasks).where(eq(schema.tasks.id, memberTaskId));
  });

  it("a plain household member, a 'health:read' delegate, and an outsider can NOT link a document to another member's appointment", async () => {
    if (!dbAvailable) return;
    const memberDocId = generateId("document");
    await db.insert(schema.documents).values({ id: memberDocId, ownerUserId: plainMemberUserId, documentType: "insurance_card", title: "Plain member's own card", tags: [] });

    for (const actorId of [plainMemberUserId, caregiverUserId, outsiderUserId]) {
      await expect(health.linkDocumentToAppointment(memberDocId, actorId, householdVisibleAppointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    }

    await db.delete(schema.documents).where(eq(schema.documents.id, memberDocId));
  });

  it("a plain household member, a 'health:read' delegate, and an outsider can NOT export another member's appointment packet — exportHealthPacket checks ownership before ever reaching the step-up password", async () => {
    if (!dbAvailable) return;
    for (const actorId of [plainMemberUserId, caregiverUserId, outsiderUserId]) {
      await expect(health.exportHealthPacket(actorId, undefined, householdVisibleAppointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
      await expect(health.exportHealthPacket(actorId, undefined, appointmentId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    }
  });

  it("a plain household member's own account-wide export (no appointmentId) never includes another member's appointments", async () => {
    if (!dbAvailable) return;
    const manifest = await health.exportHealthPacket(plainMemberUserId, undefined, null);
    expect(manifest.appointments.map((a) => a.id)).not.toContain(appointmentId);
    expect(manifest.appointments.map((a) => a.id)).not.toContain(householdVisibleAppointmentId);
  });
});
