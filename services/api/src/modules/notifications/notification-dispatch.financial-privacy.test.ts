import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { NotificationDispatchService } from "./notification-dispatch.service";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { PreferencesService } from "../preferences/preferences.service";
import { IdentityService } from "../identity/identity.service";
import type { MailerService } from "./mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { EmailProvider, PushProvider } from "./notification-provider.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubQueue = {
  enqueueDocumentOcr: async () => {},
  enqueueNotificationDelivery: async () => {},
} as unknown as QueueProducer;
const stubEmail = {} as unknown as EmailProvider;
const stubPush = {} as unknown as PushProvider;

/**
 * FIN-007 "Allow amounts and account names to be hidden on Home, widgets, household surfaces and
 * notifications." A real gap found via spec-conformance audit: the daily/weekly brief composed a plain-text
 * body straight from attention-item reasonText / bill amounts with no masking option at all. Proves against
 * a real Postgres row that a dollar figure embedded in either brief's body is replaced with the shared
 * masked placeholder once the recipient's `financialPrivacyModeEnabled` preference is on, and is left alone
 * (proving this isn't just an unconditional redaction) when it's off.
 */
describe("NotificationDispatchService — FIN-007 masks dollar amounts in brief copy", () => {
  let db: Database;
  let dispatch: NotificationDispatchService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const identity = new IdentityService(db, stubQueue, noopMailer, stubOnboarding);
    const preferences = new PreferencesService(db, identity);
    const delivery = new NotificationDeliveryService(db, stubQueue, stubEmail, stubPush);
    dispatch = new NotificationDispatchService(db, delivery, preferences);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `fin-privacy-brief-${ownerUserId}@example.com`, displayName: "Brief Privacy Test" });
      await db.insert(schema.notificationPreferences).values({
        userId: ownerUserId,
        dailyBriefEnabled: true,
        weeklyBriefEnabled: true,
        sensitivePreviewsEnabled: true,
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping NotificationDispatchService financial-privacy tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.notifications).where(eq(schema.notifications.ownerUserId, ownerUserId));
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.ownerUserId, ownerUserId));
      await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
      await db.delete(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, ownerUserId));
      await db.delete(schema.personalizationPreferences).where(eq(schema.personalizationPreferences.userId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("daily brief shows the real dollar amount when financial privacy mode is off", async () => {
    if (!dbAvailable) return;
    await db
      .insert(schema.personalizationPreferences)
      .values({ userId: ownerUserId, financialPrivacyModeEnabled: false })
      .onConflictDoUpdate({ target: schema.personalizationPreferences.userId, set: { financialPrivacyModeEnabled: false } });

    const itemId = generateId("attentionItem");
    await db.insert(schema.attentionItems).values({
      id: itemId,
      ownerUserId,
      reasonCode: "financial_duplicate_charge",
      reasonText: "This $123.45 charge to Test Merchant happened twice within a day — might be a duplicate.",
      urgency: "important",
      confidenceBand: "needs_review",
    });

    const dedupeKey = `daily-brief:${new Date().toISOString().slice(0, 10)}`;
    await db.delete(schema.notifications).where(and(eq(schema.notifications.ownerUserId, ownerUserId), eq(schema.notifications.dedupeKey, dedupeKey)));
    await dispatch.dispatchDailyBrief();

    const [notification] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.ownerUserId, ownerUserId), eq(schema.notifications.dedupeKey, dedupeKey)));
    expect(notification?.body).toContain("$123.45");

    await db.delete(schema.notifications).where(eq(schema.notifications.id, notification!.id));
    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.id, itemId));
  });

  it("daily brief masks the dollar amount when financial privacy mode is on", async () => {
    if (!dbAvailable) return;
    await db
      .insert(schema.personalizationPreferences)
      .values({ userId: ownerUserId, financialPrivacyModeEnabled: true })
      .onConflictDoUpdate({ target: schema.personalizationPreferences.userId, set: { financialPrivacyModeEnabled: true } });

    const itemId = generateId("attentionItem");
    await db.insert(schema.attentionItems).values({
      id: itemId,
      ownerUserId,
      reasonCode: "financial_duplicate_charge",
      reasonText: "This $123.45 charge to Test Merchant happened twice within a day — might be a duplicate.",
      urgency: "important",
      confidenceBand: "needs_review",
    });

    const dedupeKey = `daily-brief:${new Date().toISOString().slice(0, 10)}`;
    await db.delete(schema.notifications).where(and(eq(schema.notifications.ownerUserId, ownerUserId), eq(schema.notifications.dedupeKey, dedupeKey)));
    await dispatch.dispatchDailyBrief();

    const [notification] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.ownerUserId, ownerUserId), eq(schema.notifications.dedupeKey, dedupeKey)));
    expect(notification?.body).not.toContain("$123.45");
    expect(notification?.body).toContain("••••");
    expect(notification?.body).toContain("Test Merchant"); // only the amount is masked, not the whole line

    await db.delete(schema.notifications).where(eq(schema.notifications.id, notification!.id));
    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.id, itemId));
  });

  it("weekly brief masks a bill's due amount when financial privacy mode is on", async () => {
    if (!dbAvailable) return;
    await db
      .insert(schema.personalizationPreferences)
      .values({ userId: ownerUserId, financialPrivacyModeEnabled: true })
      .onConflictDoUpdate({ target: schema.personalizationPreferences.userId, set: { financialPrivacyModeEnabled: true } });

    const billId = generateId("bill");
    const dueDate = new Date(Date.now() + 3 * 86_400_000);
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId,
      billerLabel: "Test Privacy Utility Co",
      amountDueMinorUnits: 8_800,
      amountDueCurrency: "USD",
      dueDate: { precision: "date", instantUtc: null, date: dueDate.toISOString().slice(0, 10), timezone: null, sourceText: null },
      dueDateSort: dueDate,
    });

    const now = new Date();
    const weekKey = `${now.getFullYear()}-W${Math.ceil((now.getDate() + now.getDay()) / 7)}`;
    const dedupeKey = `weekly-brief:${weekKey}`;
    await db.delete(schema.notifications).where(and(eq(schema.notifications.ownerUserId, ownerUserId), eq(schema.notifications.dedupeKey, dedupeKey)));
    await dispatch.dispatchWeeklyBrief();

    const [notification] = await db.select().from(schema.notifications).where(and(eq(schema.notifications.ownerUserId, ownerUserId), eq(schema.notifications.dedupeKey, dedupeKey)));
    expect(notification?.body).toContain("Test Privacy Utility Co");
    expect(notification?.body).not.toContain("$88.00");
    expect(notification?.body).toContain("••••");

    await db.delete(schema.notifications).where(eq(schema.notifications.id, notification!.id));
    await db.delete(schema.bills).where(eq(schema.bills.id, billId));
  });
});
