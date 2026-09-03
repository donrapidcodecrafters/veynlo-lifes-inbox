import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PreferencesService } from "./preferences.service";
import { IdentityService } from "../identity/identity.service";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;

/**
 * FIN-007 "Financial privacy mode ... Mask by default on lock screen; biometric reveal option." A real gap
 * found via spec-conformance audit: no preference or reveal gate existed anywhere for this. Proves against a
 * real Postgres row: (1) the flag defaults to false and genuinely persists once toggled, (2) the web reveal
 * gate reuses `IdentityService.verifyStepUpPassword`'s exact PASSWORD_REQUIRED/INVALID_CREDENTIALS shape
 * (§28.9's established pattern — same as `IdentityRecordsService.revealDocumentNumber`), and (3) every
 * outcome (success, missing password, wrong password) writes an immutable audit_events row.
 */
describe("PreferencesService — FIN-007 financial privacy mode", () => {
  let db: Database;
  let identity: IdentityService;
  let preferences: PreferencesService;
  let ownerUserId: string;
  const OWNER_PASSWORD = "correct horse battery staple finance";
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, noopMailer, stubOnboarding);
    preferences = new PreferencesService(db, identity);
    try {
      const argon2 = await import("argon2");
      ownerUserId = generateId("user");
      const passwordHash = await argon2.hash(OWNER_PASSWORD);
      await db.insert(schema.users).values({ id: ownerUserId, email: `fin-privacy-${ownerUserId}@example.com`, displayName: "Finance Privacy Test", passwordHash });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PreferencesService financial-privacy tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.auditEvents).where(and(eq(schema.auditEvents.actorId, ownerUserId), eq(schema.auditEvents.action, "financial_privacy.reveal")));
      await db.delete(schema.personalizationPreferences).where(eq(schema.personalizationPreferences.userId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("defaults financialPrivacyModeEnabled to false with no stored row, and isFinancialPrivacyModeEnabled agrees", async () => {
    if (!dbAvailable) return;
    const prefs = await preferences.getPersonalizationPreferences(ownerUserId);
    expect(prefs.financialPrivacyModeEnabled).toBe(false);
    expect(await preferences.isFinancialPrivacyModeEnabled(ownerUserId)).toBe(false);
  });

  it("persists financialPrivacyModeEnabled once toggled on, without disturbing other personalization fields", async () => {
    if (!dbAvailable) return;
    await preferences.updatePersonalizationPreferences(ownerUserId, { weekStart: "monday" });
    const enabled = await preferences.updatePersonalizationPreferences(ownerUserId, { financialPrivacyModeEnabled: true });
    expect(enabled.financialPrivacyModeEnabled).toBe(true);
    expect(enabled.weekStart).toBe("monday"); // the earlier field survives an unrelated later PATCH

    const reloaded = await preferences.getPersonalizationPreferences(ownerUserId);
    expect(reloaded.financialPrivacyModeEnabled).toBe(true);
    expect(await preferences.isFinancialPrivacyModeEnabled(ownerUserId)).toBe(true);

    // Turning it back off must actually flip the stored row, not just skip re-writing a "default" value.
    await preferences.updatePersonalizationPreferences(ownerUserId, { financialPrivacyModeEnabled: false });
    expect(await preferences.isFinancialPrivacyModeEnabled(ownerUserId)).toBe(false);
  });

  it("reveal: no password on an account with a password set throws PASSWORD_REQUIRED and audits 'denied'", async () => {
    if (!dbAvailable) return;
    await expect(preferences.revealFinancialPrivacy(ownerUserId, undefined)).rejects.toMatchObject({ response: { code: "PASSWORD_REQUIRED" } });
    const [event] = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.actorId, ownerUserId), eq(schema.auditEvents.action, "financial_privacy.reveal")))
      .orderBy(schema.auditEvents.occurredAt);
    expect(event?.result).toBe("denied");
  });

  it("reveal: wrong password throws INVALID_CREDENTIALS and audits 'failure'", async () => {
    if (!dbAvailable) return;
    await expect(preferences.revealFinancialPrivacy(ownerUserId, "definitely wrong")).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.actorId, ownerUserId), eq(schema.auditEvents.action, "financial_privacy.reveal")))
      .orderBy(schema.auditEvents.occurredAt);
    expect(events.at(-1)?.result).toBe("failure");
  });

  it("reveal: the correct password succeeds and audits 'success'", async () => {
    if (!dbAvailable) return;
    const result = await preferences.revealFinancialPrivacy(ownerUserId, OWNER_PASSWORD);
    expect(result).toEqual({ revealed: true });
    const events = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.actorId, ownerUserId), eq(schema.auditEvents.action, "financial_privacy.reveal")))
      .orderBy(schema.auditEvents.occurredAt);
    expect(events.at(-1)?.result).toBe("success");
    // Three prior tests (denied, failure, success) each wrote exactly one row — no double-logging.
    expect(events).toHaveLength(3);
  });
});
