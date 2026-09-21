import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AutomationService } from "./automation.service";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ScheduleService } from "../schedule/schedule.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = {} as unknown as NotificationDeliveryService;
const stubSchedule = {} as unknown as ScheduleService;
const stubWriteBack = {} as unknown as CalendarWriteBackService;

/**
 * An automation rule carries its householdId onto everything it creates: executeRun writes `tasks` and
 * `prepared_actions` with `rule.householdId`, and both are read back BY household - ScheduleService's task
 * list, AttentionService's Needs You, HouseholdService's open-task count. `createRuleFromText` took
 * `dto.householdId` straight from the request body and never checked the author was a member, so a rule
 * naming someone else's household injected rows into that household's shared lists every time it fired.
 *
 * Household ids are not guessable, which bounds this - but anyone who has ever seen one keeps it, and a
 * removed member is the obvious case. "Removed from the household" should end exactly this.
 *
 * Every sibling service that accepts a caller-supplied householdId already checked: lists, people,
 * identity-records, health-logistics, location, assets. The gap here was half known - executeRun's
 * add_calendar_event branch documents that routing through ScheduleService.createEvent gained the
 * membership check "the raw insert never checked", and calls a rule whose owner is no longer a member
 * "exactly the kind of state a rule should stop acting on". That reasoning reached one of the three action
 * branches and never reached the place the household is chosen.
 *
 * The check must also come before the model call: a request that cannot succeed should not spend one.
 */
describe("AutomationService.createRuleFromText - household scope", () => {
  let db: Database;
  let dbAvailable = true;
  let setupError: Error | null = null;

  const memberId = generateId("user");
  const outsiderId = generateId("user");
  const invitedId = generateId("user");
  const householdId = generateId("household");

  let aiCalls = 0;
  const makeService = () => {
    const ai = {
      isConfigured: () => {
        aiCalls++;
        return true;
      },
      extractStructured: async () => {
        aiCalls++;
        throw new Error("REACHED_MODEL");
      },
    } as unknown as ModelProvider;
    return new AutomationService(db, ai, stubNotifications, stubSchedule, stubWriteBack);
  };

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      await db.insert(schema.users).values({ id: memberId, email: `auto-mem-${memberId}@example.com`, displayName: "Member" });
    } catch {
      dbAvailable = false;
      return;
    }
    try {
      await db.insert(schema.users).values({ id: outsiderId, email: `auto-out-${outsiderId}@example.com`, displayName: "Outsider" });
      await db.insert(schema.users).values({ id: invitedId, email: `auto-inv-${invitedId}@example.com`, displayName: "Invited" });
      await db.insert(schema.households).values({ id: householdId, name: "Someone Else's Household", billingOwnerUserId: memberId });
      await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: memberId, role: "adult_member", status: "active" });
      // Invited but not yet active - isActiveMember's own boundary, so it is worth asserting rather than assuming.
      await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: invitedId, role: "adult_member", status: "invited" });
    } catch (error) {
      setupError = error as Error;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // The household goes first: households.billingOwnerUserId does NOT cascade, so deleting its billing
    // owner is refused while the row exists.
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    for (const id of [memberId, outsiderId, invitedId]) await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  it("set the fixture up", () => {
    if (!dbAvailable) return;
    expect(setupError, setupError?.message).toBeNull();
  });

  const attempt = (userId: string, household: string | null | undefined) =>
    makeService()
      .createRuleFromText(userId, { naturalLanguageSource: "remind me about the gas bill", householdId: household })
      .catch((e: Error) => e);

  it("refuses a household the author does not belong to", async () => {
    if (!dbAvailable || setupError) return;
    aiCalls = 0;
    const err = (await attempt(outsiderId, householdId)) as { response?: { code?: string }; status?: number };
    expect(err.response?.code).toBe("NOT_HOUSEHOLD_MEMBER");
    expect(err.status).toBe(403);
    // And no rule was written under that household.
    const rules = await db.select().from(schema.automationRules).where(eq(schema.automationRules.householdId, householdId));
    expect(rules).toHaveLength(0);
  });

  it("refuses before spending a model call", async () => {
    if (!dbAvailable || setupError) return;
    aiCalls = 0;
    await attempt(outsiderId, householdId);
    expect(aiCalls, "the authorization check must run before the model is consulted").toBe(0);
  });

  it("refuses an invited-but-not-active membership", async () => {
    if (!dbAvailable || setupError) return;
    const err = (await attempt(invitedId, householdId)) as { response?: { code?: string } };
    expect(err.response?.code).toBe("NOT_HOUSEHOLD_MEMBER");
  });

  it("lets an active member through the check", async () => {
    if (!dbAvailable || setupError) return;
    aiCalls = 0;
    const err = (await attempt(memberId, householdId)) as { response?: { code?: string } };
    // Reaching the model is the proof it got past the gate. The stub then throws on purpose, which the
    // service converts to its own AI_UNAVAILABLE by design, so this test never depends on an API key or
    // on what a model would return - only on having got far enough to ask one.
    expect(err.response?.code).toBe("AI_UNAVAILABLE");
    expect(aiCalls).toBeGreaterThan(0);
  });

  it("still allows a personal rule with no household at all", async () => {
    if (!dbAvailable || setupError) return;
    const err = (await attempt(memberId, null)) as { response?: { code?: string } };
    expect(err.response?.code).toBe("AI_UNAVAILABLE");
  });
});
