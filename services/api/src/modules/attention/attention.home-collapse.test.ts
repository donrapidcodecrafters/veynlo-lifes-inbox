import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

/**
 * DEF-104 — Home must not hand the client a wall of one kind of thing.
 *
 * Measured on a real account before this existed: 125 unresolved attention items, 55 of them vehicle
 * recalls, every one in the `important` tier. `priorityKey` never considers kind, so they sorted into one
 * unbroken run and pushed today's actual tasks eight measured swipes down the screen.
 *
 * These assert the PROPERTY — no kind occupies more than two consecutive rows, nothing is lost, the
 * priority order survives — rather than the mechanism, so the mechanism can change without the guarantee
 * quietly going with it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = { activeHouseholdIds: async () => [] } as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "n" }) } as unknown as NotificationDeliveryService;

describe("DEF-104 — Home collapses same-kind runs", () => {
  let db: Database;
  let ownerUserId: string;
  let attention: AttentionService;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `home-${ownerUserId}@example.com`, displayName: "Home Collapse" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DEF-104 tests — no reachable dev Postgres:", (err as Error).message);
    }
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function seed(reasonCode: string, count: number, urgency = "important", dayOffset = 0) {
    for (let i = 0; i < count; i++) {
      await db.insert(schema.attentionItems).values({
        id: generateId("attentionItem"),
        ownerUserId,
        reasonCode,
        reasonText: `${reasonCode} number ${i}`,
        urgency,
        confidenceBand: "verified",
        resolved: false,
        dueAtSort: new Date(Date.now() + dayOffset * 86_400_000 + (i + 1) * 3_600_000),
      });
    }
  }

  it("folds a real-shaped account instead of returning a wall", async () => {
    if (!dbAvailable) return;
    // The shape measured on the account that surfaced this: one kind dominating, in one urgency tier.
    // Separate due-date bands, because within one urgency tier the order is by due date — so without
    // this the two person dates land INSIDE the recall run and split it, which is real behaviour but a
    // different test (below) rather than something to discover through a confusing count.
    await seed("vehicle_recall", 55, "important", 0);
    await seed("bill_overdue", 9, "critical", 0);
    await seed("person_important_date", 2, "important", 30);

    const res = await attention.home(ownerUserId);

    // No kind occupies more than two consecutive rows. This is the guarantee, stated directly.
    let longest = 0;
    let run = 0;
    let prev: string | null = null;
    for (const it of res.items) {
      const key = (it as { group: { reasonCode: string } | null; reasonCode: string }).group?.reasonCode ?? (it as { reasonCode: string }).reasonCode;
      const isGroup = (it as { group: unknown }).group !== null;
      if (isGroup) { run = 0; prev = null; continue; }
      run = key === prev ? run + 1 : 1;
      prev = key;
      if (run > longest) longest = run;
    }
    expect(longest).toBeLessThanOrEqual(2);

    // The 55 became one card that says 55 — not a truncation, and not 55 rows.
    const recallGroup = res.items.find((i) => (i as { group: { reasonCode: string } | null }).group?.reasonCode === "vehicle_recall") as
      | { group: { count: number; members: unknown[] } }
      | undefined;
    expect(recallGroup).toBeDefined();
    expect(recallGroup!.group.count).toBe(55);
    expect(recallGroup!.group.members).toHaveLength(55);

    // Nothing is lost: every seeded item is still reachable, collapsed or not.
    const reachable = res.items.flatMap((i) => {
      const g = (i as { group: { members: unknown[] } | null }).group;
      return g ? g.members : [i];
    });
    expect(reachable).toHaveLength(66);

    // The two person dates are BELOW the collapse threshold, so they stay as ordinary rows.
    const plain = res.items.filter((i) => (i as { group: unknown }).group === null && (i as { reasonCode: string }).reasonCode === "person_important_date");
    expect(plain).toHaveLength(2);
  });

  it("keeps the priority order — critical still outranks important after collapsing", async () => {
    if (!dbAvailable) return;
    const first = (res: { items: unknown[] }) => {
      const i = res.items[0] as { group: { reasonCode: string } | null; reasonCode: string };
      return i.group?.reasonCode ?? i.reasonCode;
    };
    const res = await attention.home(ownerUserId);
    // bill_overdue is `critical`; the 55 recalls are `important`. Collapsing must not promote the big group.
    expect(first(res)).toBe("bill_overdue");
  });

  it("reports whether the ceiling bit, rather than truncating silently", async () => {
    if (!dbAvailable) return;
    const res = await attention.home(ownerUserId) as unknown as { truncated: boolean; totalItems: number };
    expect(res.truncated).toBe(false);
    expect(res.totalItems).toBe(66);
  });
});

/**
 * The behaviour the first draft of this file discovered by accident, pinned deliberately.
 *
 * Collapsing is by ADJACENCY, not by key, so an item of another kind landing in the middle of a run splits
 * it into two — and that is correct rather than unfortunate. Grouping by key alone would pull the two
 * halves back together and silently move the interloper, overruling the priority sort that put it there.
 * A user whose child's birthday sorts between two recalls should see it between two recalls.
 */
describe("DEF-104 — collapsing never overrules the priority sort", () => {
  let db: Database;
  let ownerUserId: string;
  let attention: AttentionService;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `split-${ownerUserId}@example.com`, displayName: "Split" });
    } catch {
      dbAvailable = false;
    }
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("splits a run around an item that genuinely sorts into the middle of it", async () => {
    if (!dbAvailable) return;
    const add = async (reasonCode: string, hours: number) => {
      await db.insert(schema.attentionItems).values({
        id: generateId("attentionItem"),
        ownerUserId,
        reasonCode,
        reasonText: `${reasonCode} at +${hours}h`,
        urgency: "important",
        confidenceBand: "verified",
        resolved: false,
        dueAtSort: new Date(Date.now() + hours * 3_600_000),
      });
    };
    for (const h of [1, 2, 3]) await add("vehicle_recall", h);
    await add("person_important_date", 4);
    for (const h of [5, 6, 7]) await add("vehicle_recall", h);

    const res = await attention.home(ownerUserId);
    const shape = res.items.map((i) => {
      const g = (i as { group: { reasonCode: string; count: number } | null }).group;
      return g ? `${g.reasonCode}x${g.count}` : (i as { reasonCode: string }).reasonCode;
    });

    // Two groups of three with the birthday still between them — not one group of six with the birthday
    // displaced to an end, which is what key-based grouping would have produced.
    expect(shape).toEqual(["vehicle_recallx3", "person_important_date", "vehicle_recallx3"]);
  });
});
