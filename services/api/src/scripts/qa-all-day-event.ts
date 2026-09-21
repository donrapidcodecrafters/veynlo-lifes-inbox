/**
 * Creates (or removes) an all-day event dated TODAY in the demo owner's own timezone.
 *
 * Through the ORM, not raw SQL: `calendar_events.title` is an encrypted column, so a row inserted with
 * psql comes back as "[content unavailable — decryption failed]" and any assertion about what is on screen
 * is meaningless. That is not hypothetical — the first version of this fixture was a psql INSERT, and the
 * browser check failed against a Home page that was behaving correctly.
 *
 * The sort key is written as UTC midnight deliberately: that is exactly what every writer stores for a
 * date-only value, and it is the value the Today query used to compare against a local-day window.
 *
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-all-day-event.ts
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-all-day-event.ts --clean
 */
import { createDbClient, schema } from "@veynlo/db";
import { eq } from "drizzle-orm";

const db = createDbClient(process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo");
const ID = "cal_qa_all_day";
const TITLE = "All-day school closure (QA)";
const OWNER = "usr_demo_alex";

async function main() {
  if (process.argv.includes("--clean")) {
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, ID));
    console.log("removed the QA all-day event");
    process.exit(0);
  }

  const [owner] = await db.select({ timezone: schema.users.timezone }).from(schema.users).where(eq(schema.users.id, OWNER)).limit(1);
  const zone = owner?.timezone || "UTC";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

  await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, ID));
  await db.insert(schema.calendarEvents).values({
    id: ID,
    ownerUserId: OWNER,
    title: TITLE,
    start: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
    startSort: new Date(`${today}T00:00:00Z`),
    isAllDay: true,
    source: "user_entered",
    visibility: "private",
  } as never);

  console.log(`created an all-day event for ${today} (${zone}), sort key ${today}T00:00:00Z`);
  process.exit(0);
}

void main();
