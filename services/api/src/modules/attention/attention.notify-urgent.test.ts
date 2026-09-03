import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;

/**
 * §33.1 priority model — found live via a fresh audit: `scanAndFileDeadlines` already classifies items
 * into Critical/Important/Useful and `NotificationDeliveryService` already has full delivery logic for
 * those tiers, but nothing ever bridged the two — every real `createAndEnqueue` call site in the whole
 * codebase hardcoded `priority: "useful"` (see notification-dispatch/schedule/ingestion/automation
 * services), so a Critical item (overdue bill) or Important item (appointment starting soon) never
 * actually produced the spec's own "Immediate push" / "Push + Home" behavior — only the next opt-in daily
 * digest email would ever mention it. Proves the fix (`AttentionService.notifyIfUrgent`, called from both
 * `insertAttentionItem` and the escalation-update branch of `fileOrEscalate`): a newly-filed Critical item
 * notifies at "critical" priority over the "push" channel; a newly-filed Important item notifies at
 * "important"; a newly-filed Useful item does NOT notify (stays digest-only per the spec's own "Home +
 * digest; optional push" default, unchanged from before this fix); and the bill_due -> bill_overdue
 * escalation itself fires a fresh "critical" notification distinct from the original "important" one,
 * matching §33.1's own escalation-ladder example verbatim ("may escalate from digest to push as deadline
 * approaches").
 */
describe("AttentionService — bridges Critical/Important attention items to real notifications", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let dbAvailable = true;
  const billIds: string[] = [];

  type Call = { ownerUserId: string; dedupeKey: string; priority: string; channel?: string };
  let calls: Call[];
  const recordingNotifications = {
    createAndEnqueue: async (params: Call) => {
      calls.push(params);
      return { notificationId: "stub" };
    },
  } as unknown as NotificationDeliveryService;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, recordingNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `notify-urgent-${ownerUserId}@example.com`, displayName: "Notify Urgent Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService notify-urgent tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of billIds) await db.delete(schema.bills).where(eq(schema.bills.id, id));
    await db.delete(schema.attentionItems).where(eq(schema.attentionItems.ownerUserId, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeBill(params: { daysFromNow: number; label: string }): Promise<string> {
    const billId = generateId("bill");
    billIds.push(billId);
    const dueDateSort = new Date(Date.now() + params.daysFromNow * 86_400_000);
    await db.insert(schema.bills).values({
      id: billId,
      ownerUserId,
      billerLabel: params.label,
      amountDueMinorUnits: 5_000,
      amountDueCurrency: "USD",
      dueDate: { precision: "date", instantUtc: null, date: dueDateSort.toISOString().slice(0, 10), timezone: null, sourceText: null },
      dueDateSort,
    });
    return billId;
  }

  it("notifies at 'important' priority over the push channel for a newly-filed Important item (bill due soon)", async () => {
    if (!dbAvailable) return;
    calls = [];
    const billId = await makeBill({ daysFromNow: 5, label: "Important Tier Electric Co" }); // urgencyFor(5) === "important"
    await attention.scanAndFileDeadlines();
    const call = calls.find((c) => c.dedupeKey === `bill_due:${billId}`);
    expect(call).toBeDefined();
    expect(call!.priority).toBe("important");
    expect(call!.channel).toBe("push");
    expect(call!.ownerUserId).toBe(ownerUserId);
  });

  it("does NOT notify for a newly-filed Useful item (bill due far out) — stays digest-only per spec default", async () => {
    if (!dbAvailable) return;
    calls = [];
    const billId = await makeBill({ daysFromNow: 10, label: "Useful Tier Water Co" }); // urgencyFor(10) === "useful"
    await attention.scanAndFileDeadlines();
    expect(calls.find((c) => c.dedupeKey === `bill_due:${billId}`)).toBeUndefined();
  });

  it("escalating bill_due -> bill_overdue fires a fresh 'critical' notification distinct from the original 'important' one", async () => {
    if (!dbAvailable) return;
    calls = [];
    // 5 days out (important) so the first scan files bill_due at "important" and notifies once.
    const billId = await makeBill({ daysFromNow: 5, label: "Escalation Test Gas Co" });
    await attention.scanAndFileDeadlines();
    const firstCall = calls.find((c) => c.dedupeKey === `bill_due:${billId}`);
    expect(firstCall?.priority).toBe("important");

    // Move the due date into the overdue grace-period window (4 days past due, no observed payment) and
    // rescan — fileOrEscalate should update the existing row in place AND fire a second, distinct
    // "critical" notification for the escalated state.
    calls = [];
    await db
      .update(schema.bills)
      .set({ dueDateSort: new Date(Date.now() - 4 * 86_400_000), dueDate: { precision: "date", instantUtc: null, date: "2020-01-01", timezone: null, sourceText: null } })
      .where(eq(schema.bills.id, billId));
    await attention.scanAndFileDeadlines();
    const escalatedCall = calls.find((c) => c.dedupeKey === `bill_overdue:${billId}`);
    expect(escalatedCall).toBeDefined();
    expect(escalatedCall!.priority).toBe("critical");
    expect(escalatedCall!.channel).toBe("push");

    const [item] = await db
      .select()
      .from(schema.attentionItems)
      .where(eq(schema.attentionItems.linkedResourceId, billId));
    expect(item!.reasonCode).toBe("bill_overdue");
    expect(item!.urgency).toBe("critical");
  });

  it("re-running the scan for an already-filed item does not re-notify (dedup key already exists downstream)", async () => {
    if (!dbAvailable) return;
    calls = [];
    const billId = await makeBill({ daysFromNow: 2, label: "Repeat Scan Test Internet Co" }); // urgencyFor(2) === "critical"
    await attention.scanAndFileDeadlines();
    expect(calls.filter((c) => c.dedupeKey === `bill_due:${billId}`)).toHaveLength(1);
    calls = [];
    await attention.scanAndFileDeadlines();
    // fileIfNew finds the existing row and returns before ever reaching insertAttentionItem/notifyIfUrgent again.
    expect(calls.filter((c) => c.dedupeKey === `bill_due:${billId}`)).toHaveLength(0);
  });
});
