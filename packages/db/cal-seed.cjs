process.env.FIELD_ENCRYPTION_KEY = "dev-only-field-encryption-key-change-me";
process.env.FIELD_ENCRYPTION_KEY_VERSION = "1";

const { createDbClient, schema } = require("/Users/donaldlundgren/veynlo-src/packages/db/dist/index.js");
const { generateId } = require("/Users/donaldlundgren/veynlo-src/packages/core/dist/index.js");
const { eq, and } = require("drizzle-orm");

const DATABASE_URL = "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

async function main() {
  const cmd = process.argv[2];
  const db = createDbClient(DATABASE_URL);

  if (cmd === "seed-event") {
    const ownerUserId = process.argv[3];
    const title = process.argv[4] || "Dentist appointment";
    const startIso = process.argv[5] || new Date(Date.now() + 3 * 86400000).toISOString();
    const id = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId,
      householdId: null,
      title,
      start: { precision: "instant", instantUtc: startIso, date: null, timezone: "America/New_York", sourceText: null },
      startSort: new Date(startIso),
      end: { precision: "instant", instantUtc: new Date(new Date(startIso).getTime() + 3600000).toISOString(), date: null, timezone: "America/New_York", sourceText: null },
      isAllDay: false,
      location: "123 Main St",
      source: "discovered_from_evidence",
      status: "confirmed",
      visibility: "private",
    });
    console.log(JSON.stringify({ id }));
  } else if (cmd === "seed-recurring-task") {
    const ownerUserId = process.argv[3];
    const dueIso = process.argv[4];
    const id = generateId("task");
    await db.insert(schema.tasks).values({
      id,
      ownerUserId,
      householdId: null,
      title: "Take out recycling",
      dueCondition: { precision: "date", instantUtc: null, date: dueIso, timezone: null, sourceText: null },
      dueSort: new Date(`${dueIso}T00:00:00Z`),
      priority: "medium",
      recurrenceRule: "FREQ=WEEKLY;BYDAY=MO",
      state: "open",
    });
    console.log(JSON.stringify({ id }));
  } else if (cmd === "check-task") {
    const id = process.argv[3];
    const [t] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).limit(1);
    console.log(JSON.stringify(t));
  } else if (cmd === "check-conflicts") {
    const rows = await db.select().from(schema.scheduleConflicts);
    console.log(JSON.stringify(rows));
  } else if (cmd === "count-tasks-title") {
    const ownerUserId = process.argv[3];
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    console.log(JSON.stringify(rows.map(r => ({ id: r.id, title: r.title, state: r.state, dueSort: r.dueSort, recurrenceRule: r.recurrenceRule }))));
  } else if (cmd === "cleanup-user") {
    const ownerUserId = process.argv[3];
    await db.delete(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    console.log("cleaned");
  } else {
    console.error("unknown command", cmd);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
