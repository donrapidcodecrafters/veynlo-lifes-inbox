import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SYNCABLE_SCHOOL_SOURCE_KINDS, SchoolService } from "./school.service";
import type { HouseholdService } from "../household/household.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { SchoolIcsService } from "./school-ics.service";
import type { CanvasService } from "./canvas.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * Is a school source that CAN sync actually ever ASKED to?
 *
 * The recurring scan tick used to filter on the literal `kind = "ics"`. Canvas would have landed straight
 * into the same trap the connectors were already in: it syncs once when it is created, then never again,
 * while the household's list keeps reporting it healthy — because nothing failed. Nothing ran.
 *
 * The query below is the one worker-main.ts's schoolSourceScanWorker runs, built from the same exported
 * list the worker uses, against real rows. A future kind added to the enum and to a service but not to
 * that list fails here rather than shipping silent.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("the recurring school-source scan", () => {
  let db: Database;
  let ownerUserId: string;
  let householdId: string;
  let dbAvailable = true;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `scan-${ownerUserId}@example.com`, displayName: "Scan Test" });
      await db.insert(schema.households).values({ id: householdId, name: "Scan Test Household", billingOwnerUserId: ownerUserId });

      const rows: Array<[string, "ics" | "canvas" | "forwarding_email", boolean]> = [
        // key, kind, unsubscribed
        ["ics", "ics", false],
        ["canvas", "canvas", false],
        ["email", "forwarding_email", false],
        ["canvasGone", "canvas", true],
      ];
      for (const [key, kind, unsubscribed] of rows) {
        const id = generateId("schoolSource");
        ids[key] = id;
        await db.insert(schema.schoolSources).values({
          id,
          householdId,
          createdByUserId: ownerUserId,
          label: `${kind} source`,
          kind,
          icsUrl: kind === "ics" ? "https://example.com/feed.ics" : null,
          apiBaseUrl: kind === "canvas" ? "https://school.instructure.com" : null,
          apiToken: kind === "canvas" ? "tok" : null,
          disconnectedAt: unsubscribed ? new Date() : null,
        });
      }
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "school source scan tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  /** Exactly the query worker-main.ts's schoolSourceScanWorker runs. */
  async function eligible(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.schoolSources.id })
      .from(schema.schoolSources)
      .where(and(inArray(schema.schoolSources.kind, [...SYNCABLE_SCHOOL_SOURCE_KINDS]), isNull(schema.schoolSources.disconnectedAt)));
    return rows.map((r) => r.id);
  }

  it("picks up a Canvas source", async () => {
    if (!dbAvailable) return;
    // The assertion this file exists for. Before the fix this returned false and a connected Canvas
    // account would have gone quiet after its first sync.
    expect(await eligible()).toContain(ids.canvas);
  });

  it("still picks up an ICS feed", async () => {
    if (!dbAvailable) return;
    expect(await eligible()).toContain(ids.ics);
  });

  it("leaves a forwarding-email source alone, because there is nothing to poll", async () => {
    if (!dbAvailable) return;
    // Forwarded mail arrives through the user's inbound alias on its own; scanning it would be a job that
    // does nothing, forever.
    expect(await eligible()).not.toContain(ids.email);
  });

  it("does not sync a source the household unsubscribed from", async () => {
    if (!dbAvailable) return;
    expect(await eligible()).not.toContain(ids.canvasGone);
  });

  it("names every kind that has a sync path", async () => {
    if (!dbAvailable) return;
    // Guards the list itself rather than the query: a kind dropped from both would still satisfy the
    // pairwise checks above.
    expect([...SYNCABLE_SCHOOL_SOURCE_KINDS]).toEqual(["ics", "canvas"]);
  });

  it("never hands a credential back out of the list endpoint", async () => {
    if (!dbAvailable) return;
    // `listSchoolSources` was `select()`, which returns every column — including the ICS feed URL (which
    // this table's own schema comment calls "typically a long unguessable-token URL") and, once Canvas
    // landed, an access token that can read a student's whole Canvas account.
    //
    // The row is visible to every household member AND to delegates, so a credential that can be read
    // back out is one that leaks through the first over-broad sharing bug. No client has ever wanted
    // these: both are write-only in practice, set on the subscribe form and never displayed again.
    const households = {
      activeHouseholdIds: async () => [householdId],
      delegatedHouseholdIds: async () => [],
    } as unknown as HouseholdService;
    const school = new SchoolService(
      db,
      households,
      {} as unknown as ConflictService,
      {} as unknown as SchoolIcsService,
      {} as unknown as CanvasService,
      {} as unknown as QueueProducer,
    );

    const rows = await school.listSchoolSources(ownerUserId);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("apiToken");
      expect(row).not.toHaveProperty("apiBaseUrl");
      expect(row).not.toHaveProperty("icsUrl");
    }
    // And still returns what the screen actually renders, so this is a narrowing rather than a gutting.
    expect(rows[0]).toHaveProperty("label");
    expect(rows[0]).toHaveProperty("health");
    expect(rows[0]).toHaveProperty("itemsDiscoveredCount");
  });
});
