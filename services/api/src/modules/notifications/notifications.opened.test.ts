import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { NotificationsService } from "./notifications.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * `notifications.openedAt` is written, and written once.
 *
 * The column existed and both clients rendered "· Opened <when>" from it, but nothing in the system ever
 * set it — so that line was unreachable for every user on every platform. This covers the behaviour that
 * makes it real, and the two ways it could quietly go wrong:
 *
 *   a second open must not overwrite the first. Two handlers can fire for one tap (a cold-start replay and
 *   a foreground listener), and overwriting would turn "how long until they looked" into "when did they
 *   last look" without anything appearing to break;
 *
 *   another user's notification must not be marked, and must not be distinguishable from one that does not
 *   exist — an id from a push payload is caller-supplied input.
 */
describe("NotificationsService.markOpened", () => {
  let db: Database;
  let notifications: NotificationsService;
  let ownerUserId: string;
  let strangerUserId: string;
  let dbAvailable = true;

  const notificationId = () => `ntf_opened_${generateId("notification")}`;

  const seed = async (id: string, userId: string) => {
    await db.insert(schema.notifications).values({
      id,
      ownerUserId: userId,
      dedupeKey: id,
      priority: "important",
      channel: "push",
      title: "A thing needs you",
      body: "Tap to see it",
      state: "sent",
      scheduledFor: new Date(),
      sentAt: new Date(),
    } as never);
  };

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    notifications = new NotificationsService(db);
    try {
      ownerUserId = generateId("user");
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `ntf-owner-${ownerUserId}@example.com`, displayName: "Notification Owner" },
        { id: strangerUserId, email: `ntf-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "NotificationsService.markOpened tests");
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of [ownerUserId, strangerUserId]) {
      await db.delete(schema.notifications).where(eq(schema.notifications.ownerUserId, id));
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  it("records the open, and the row reflects it", async () => {
    if (!dbAvailable) return;
    const id = notificationId();
    await seed(id, ownerUserId);

    const before = await notifications.list(ownerUserId);
    expect(before.find((n) => n.id === id)?.openedAt).toBeNull();

    const result = await notifications.markOpened(id, ownerUserId);
    expect(result.openedAt).toBeInstanceOf(Date);

    const after = await notifications.list(ownerUserId);
    expect(after.find((n) => n.id === id)?.openedAt).toBeInstanceOf(Date);
  });

  it("keeps the FIRST open when it is reported twice", async () => {
    if (!dbAvailable) return;
    const id = notificationId();
    await seed(id, ownerUserId);

    const first = await notifications.markOpened(id, ownerUserId);
    await new Promise((r) => setTimeout(r, 25));
    const second = await notifications.markOpened(id, ownerUserId);

    // Both tap handlers can fire for a single notification, so this is the ordinary case, not an edge one.
    expect(second.openedAt).toEqual(first.openedAt);
  });

  it("will not mark another user's notification, and says nothing about it", async () => {
    if (!dbAvailable) return;
    const id = notificationId();
    await seed(id, strangerUserId);

    const result = await notifications.markOpened(id, ownerUserId);
    expect(result.openedAt).toBeNull();

    // The stranger's row is untouched.
    const theirs = await notifications.list(strangerUserId);
    expect(theirs.find((n) => n.id === id)?.openedAt).toBeNull();

    // And an id that never existed answers exactly the same way, so this cannot be used to discover which
    // notification ids are real. Compared on the ANSWER rather than the whole object: both echo the id
    // they were handed, so comparing objects would be comparing the two different inputs.
    const missing = await notifications.markOpened("ntf_does_not_exist", ownerUserId);
    expect(missing.openedAt).toBeNull();
    expect(Object.keys(missing).sort()).toEqual(Object.keys(result).sort());
  });
});
