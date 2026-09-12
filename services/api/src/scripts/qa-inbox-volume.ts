/**
 * Loads the demo account's Inbox with enough items to actually exercise pagination.
 *
 * The seed fixture is 28 items, which is realistic for a new account and is below one page — so it can
 * demonstrate folding but not paging. This pushes it past several pages so "Load more", the cursor walk,
 * and the virtualised list have something to do.
 *
 * Written through the ORM rather than raw SQL on purpose: `summary` is an encrypted column, and rows
 * inserted straight into Postgres come back as "[content unavailable — decryption failed]", which would
 * make every assertion about what is on screen meaningless.
 *
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-inbox-volume.ts 150
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-inbox-volume.ts --clean
 */
import { createDbClient, schema } from "@veynlo/db";
import { like } from "drizzle-orm";

const db = createDbClient(process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo");
const PREFIX = "inb_qa_volume_";

const CATEGORIES = ["purchase", "bill", "appointment", "document", "travel", "warranty"] as const;

async function main() {
  if (process.argv.includes("--clean")) {
    await db.delete(schema.inboxItems).where(like(schema.inboxItems.id, `${PREFIX}%`));
    console.log("removed the QA volume rows");
    process.exit(0);
  }

  const count = Number(process.argv[2] ?? 150);
  const rows = Array.from({ length: count }, (_, n) => ({
    id: `${PREFIX}${String(n).padStart(4, "0")}`,
    ownerUserId: "usr_demo_alex",
    // --one-category puts every item in a single category, so filtering to it produces one LONG flat
    // list. Spread across six categories the longest filtered list is a sixth of the volume, which is
    // too short to tell a virtualised list from an unvirtualised one — the first attempt at measuring
    // this compared two runs of ~25 rows and unsurprisingly found no difference.
    category: process.argv.includes("--one-category") ? CATEGORIES[0] : CATEGORIES[n % CATEGORIES.length],
    summary: `Volume fixture item ${n + 1} — a realistically long inbox summary line that wraps on a phone, so layout is exercised too`,
    sourceEventId: "src_demo_vacuum_receipt",
    suggestedActions: ["confirm"],
    reviewState: "new" as const,
    confidenceBand: "verified",
    // Distinct, descending timestamps so the ordering is unambiguous and the cursor walk is meaningful.
    createdAt: new Date(Date.now() - (n + 100) * 60_000),
    updatedAt: new Date(),
  }));

  await db.insert(schema.inboxItems).values(rows as never).onConflictDoNothing();
  console.log(`inserted ${count} QA inbox items through the encrypted write path`);
  process.exit(0);
}

void main();
