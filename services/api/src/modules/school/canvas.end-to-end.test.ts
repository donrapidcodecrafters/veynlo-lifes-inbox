import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CanvasService } from "./canvas.service";
import { IngestionService } from "../ingestion/ingestion.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * A Canvas assignment, all the way to a row a parent can see.
 *
 * The unit tests prove the normalizers; `canvas.sync.test.ts` proves the requests. Neither proves the
 * join, which is where a connector usually fails in practice: the data is fetched correctly and then
 * lands nowhere, or lands twice, or lands with its due date detached from it.
 *
 * So this runs the real sync against a real HTTPS server and a real database, and then reads
 * `school_events` back.
 *
 *   NODE_EXTRA_CA_CERTS=<repo>/.claude/test-certs/localhost-cert.pem npx vitest run src/modules/school/canvas.end-to-end.test.ts
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/** Reaches the local test server; the SSRF guard's own refusals are tested in canvas.sync.test.ts. */
class LocalCanvasService extends CanvasService {
  protected override async assertHostAllowed(hostname: string): Promise<void> {
    if (hostname === "127.0.0.1") return;
    return super.assertHostAllowed(hostname);
  }
}

let server: https.Server;
let origin: string;
/** Flipped mid-test to prove a changed assignment updates its row rather than creating a second one. */
let assignmentTitle = "Chapter 4 Questions";
/** Flipped to make the token check fail, so the health message for a rejected token can be asserted. */
let selfRejects = false;

describe("a Canvas assignment becomes a school event", () => {
  let db: Database;
  let canvas: LocalCanvasService;
  let ownerUserId: string;
  let householdId: string;
  let sourceId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    const certDir = path.join(__dirname, "..", "..", "..", "..", "..", ".claude", "test-certs");
    server = https.createServer(
      { key: fs.readFileSync(path.join(certDir, "localhost-key.pem")), cert: fs.readFileSync(path.join(certDir, "localhost-cert.pem")) },
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const json = (body: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (url.pathname === "/api/v1/users/self") {
          if (selfRejects) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
            return;
          }
          return json({ id: 1, name: "Maya Rivera" });
        }
        if (url.pathname === "/api/v1/courses") {
          if (selfRejects) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ errors: [{ message: "Invalid access token." }] }));
            return;
          }
          return json([{ id: 12, name: "Algebra II" }]);
        }
        if (url.pathname === "/api/v1/courses/12/assignments") {
          return json([
            { id: 991, name: assignmentTitle, due_at: "2026-04-15T23:59:00Z", description: "<p>Show your work.</p>" },
            // No due date: real, and deliberately not filed as an event — there is nothing to be late for.
            { id: 992, name: "Extra credit", due_at: null },
          ]);
        }
        if (url.pathname === "/api/v1/announcements") return json([]);
        res.writeHead(404);
        res.end("{}");
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

    db = createDbClient(DATABASE_URL);
    try {
      // The real IngestionService is not constructible here without most of the application, so the
      // filing path it owns is covered by its own tests; what this exercises is CanvasService's use of it
      // plus the real rows that come out the other side.
      const ingestion = {
        ingestFeedSchoolEvent: async (params: {
          ownerUserId: string;
          householdId: string | null;
          schoolSourceId: string;
          schoolId: string | null;
          uid: string;
          title: string;
          start: unknown;
          description: string | null;
          eventKind?: string;
        }) => {
          const [existing] = await db
            .select({ id: schema.schoolEvents.id })
            .from(schema.schoolEvents)
            .where(and(eq(schema.schoolEvents.schoolSourceId, params.schoolSourceId), eq(schema.schoolEvents.providerEventId, params.uid)))
            .limit(1);
          if (existing) {
            await db.update(schema.schoolEvents).set({ title: params.title }).where(eq(schema.schoolEvents.id, existing.id));
            return false;
          }
          await db.insert(schema.schoolEvents).values({
            id: generateId("schoolEvent"),
            ownerUserId: params.ownerUserId,
            householdId: params.householdId,
            schoolSourceId: params.schoolSourceId,
            kind: params.eventKind ?? "other",
            title: params.title,
            description: params.description,
            start: params.start as never,
            startSort: new Date("2026-04-15T23:59:00Z"),
            isAllDay: false,
            source: "feed",
            providerEventId: params.uid,
            confidenceBand: "verified",
          });
          return true;
        },
      } as unknown as IngestionService;

      canvas = new LocalCanvasService(db, ingestion);

      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `canvas-${ownerUserId}@example.com`, displayName: "Canvas Test" });
      await db.insert(schema.households).values({ id: householdId, name: "Canvas Test Household", billingOwnerUserId: ownerUserId });

      sourceId = generateId("schoolSource");
      await db.insert(schema.schoolSources).values({
        id: sourceId,
        householdId,
        createdByUserId: ownerUserId,
        label: "Maya's school work",
        kind: "canvas",
        apiBaseUrl: origin,
        apiToken: "test-token",
        health: "initializing",
      });
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "Canvas end-to-end test");
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("files the assignment with its due date and its course", async () => {
    if (!dbAvailable) return;
    const result = await canvas.sync(sourceId);
    expect(result.itemCount).toBe(1);

    const rows = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.schoolSourceId, sourceId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Chapter 4 Questions — Algebra II");
    expect(rows[0]?.kind).toBe("assignment");
    expect((rows[0]?.start as { instantUtc: string })?.instantUtc).toBe("2026-04-15T23:59:00.000Z");
    // The HTML body was reduced to readable text, not stored as markup.
    expect(rows[0]?.description).toBe("Show your work.");
  });

  it("does not file an assignment that has no due date", async () => {
    if (!dbAvailable) return;
    // "Extra credit" is a real assignment with no deadline. Giving it an invented date would put a
    // deadline on a parent's calendar that nobody set.
    const rows = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.schoolSourceId, sourceId));
    expect(rows.some((r) => r.title.includes("Extra credit"))).toBe(false);
  });

  it("marks the source healthy with a real sync timestamp", async () => {
    if (!dbAvailable) return;
    const [source] = await db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, sourceId));
    expect(source?.health).toBe("healthy");
    expect(source?.lastSuccessfulSyncAt).toBeTruthy();
  });

  it("updates the existing row when the assignment is renamed, rather than adding a second one", async () => {
    if (!dbAvailable) return;
    // A teacher fixing a typo in an assignment name must not produce two deadlines for one piece of work.
    assignmentTitle = "Chapter 4 Questions (revised)";
    try {
      await canvas.sync(sourceId);
      const rows = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.schoolSourceId, sourceId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe("Chapter 4 Questions (revised) — Algebra II");
    } finally {
      assignmentTitle = "Chapter 4 Questions";
    }
  });

  it("says the token was rejected when the token was rejected", async () => {
    if (!dbAvailable) return;
    // What a household is told decides what they do about it. "Your token was rejected" sends somebody to
    // Canvas to generate a new one; if the real problem were the address, they would do that and it would
    // still not work.
    selfRejects = true;
    try {
      await canvas.sync(sourceId).catch(() => {});
      const [source] = await db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, sourceId));
      expect(source?.health).toBe("degraded");
      expect(source?.healthDetail).toMatch(/rejected the saved access token/i);
    } finally {
      selfRejects = false;
    }
  });

  it("says the ADDRESS is the problem when the address is the problem", async () => {
    if (!dbAvailable) return;
    // The distinction this asserts is the reason the branch reads an error code rather than an exception
    // class: the SSRF guard and the scheme check throw the same class as a rejected token, so a host
    // repointed at a private address used to be reported as a revoked credential.
    const brokenId = generateId("schoolSource");
    await db.insert(schema.schoolSources).values({
      id: brokenId,
      householdId,
      createdByUserId: ownerUserId,
      label: "Repointed Canvas",
      kind: "canvas",
      // Stored as a public-looking origin, but resolving somewhere this app must never call.
      apiBaseUrl: "https://169.254.169.254",
      apiToken: "tok",
      health: "healthy",
    });
    // The REAL service here, not the local subclass — the guard is exactly what is being exercised.
    const strict = new CanvasService(db, {} as unknown as IngestionService);
    await strict.sync(brokenId).catch(() => {});
    const [source] = await db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, brokenId));
    expect(source?.health).toBe("degraded");
    expect(source?.healthDetail).toMatch(/address can no longer be reached safely/i);
    expect(source?.healthDetail).not.toMatch(/token/i);
  });

  it("stores the token encrypted, not as readable text", async () => {
    if (!dbAvailable) return;
    // The ORM decrypts on read, so the check has to go around it to the raw column. A token sitting in
    // plaintext is the whole account readable by anyone who reaches the database.
    const raw = await db.execute(sql`select api_token from school_sources where id = ${sourceId}`);
    const stored = (raw as unknown as { rows?: { api_token: string | null }[] }).rows?.[0]?.api_token ?? null;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe("test-token");
  });
});
