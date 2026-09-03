import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IdentityService } from "./identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

/**
 * Round-3 audit finding: the `/settings/security` page's whole purpose is "sign out of a device you don't
 * recognize", but every session row rendered identically ("Web browser", same-second timestamp — this
 * repo's dev environment sets no `devices.displayName`, and two browser contexts on the same OS both get
 * `platform: "web"`) — confirmed live with two real simultaneous sessions for the same account: nothing on
 * the page (or in the API response) indicated which row was the one the viewer was currently using. Fixed
 * by threading `AuthenticatedUser.sessionId` (already on every request via the JWT) through to
 * `listSessions`, which now marks the caller's own row `isCurrent: true`. This is real-DB coverage for the
 * service method itself; the web/mobile "This device" badge is the client-side half.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

describe("IdentityService.listSessions — isCurrent", () => {
  let db: Database;
  let identity: IdentityService;
  let userId: string;
  let sessionAId: string;
  let sessionBId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    try {
      userId = generateId("user");
      sessionAId = generateId("session");
      sessionBId = generateId("session");
      await db.insert(schema.users).values({ id: userId, email: `list-sessions-current-${userId}@example.com`, displayName: "Session Marker Test" });
      const expiresAt = new Date(Date.now() + 3600_000);
      await db.insert(schema.sessions).values([
        { id: sessionAId, userId, refreshTokenHash: `hash-a-${sessionAId}`, expiresAt },
        { id: sessionBId, userId, refreshTokenHash: `hash-b-${sessionBId}`, expiresAt },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IdentityService.listSessions isCurrent tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });

  it("marks only the session matching the passed-in currentSessionId as isCurrent, never any other row", async () => {
    if (!dbAvailable) return;
    const rowsFromA = await identity.listSessions(userId, sessionAId);
    const a1 = rowsFromA.find((r) => r.id === sessionAId);
    const b1 = rowsFromA.find((r) => r.id === sessionBId);
    expect(a1?.isCurrent).toBe(true);
    expect(b1?.isCurrent).toBe(false);

    // Same two rows, viewed from device B's own session — the marker flips, it's never sticky to one row.
    const rowsFromB = await identity.listSessions(userId, sessionBId);
    const a2 = rowsFromB.find((r) => r.id === sessionAId);
    const b2 = rowsFromB.find((r) => r.id === sessionBId);
    expect(a2?.isCurrent).toBe(false);
    expect(b2?.isCurrent).toBe(true);
  });
});
