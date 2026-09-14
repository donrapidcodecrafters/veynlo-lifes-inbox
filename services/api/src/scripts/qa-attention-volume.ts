/**
 * Loads the demo account's Home feed with a realistic heavy-user volume.
 *
 * DEF-104 measured a real account at 125 attention items with 55 of one kind. The seed has 9, which is
 * why a screen that is fine at 9 rows and unusable at 125 looked perfect in every screenshot this audit
 * took, on every device, in both themes.
 *
 * The distribution matters as much as the count. A flat spread across reason codes would collapse into
 * almost nothing and flatter the result; a single giant run would collapse into one row and flatter it
 * differently. This mirrors the shape actually observed: one dominant kind, a few medium ones, and a long
 * tail of singletons that cannot be collapsed at all — which is the case that decides whether Home needs
 * virtualising.
 *
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-attention-volume.ts 150
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-attention-volume.ts --clean
 */
import { createDbClient, schema } from "@veynlo/db";
import { like } from "drizzle-orm";

const db = createDbClient(process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo");
const PREFIX = "att_qa_volume_";

/** [reason code, how many, urgency] — one dominant kind, some medium, then a tail of singletons. */
const SHAPE: Array<[string, number, "important" | "useful" | "critical"]> = [
  ["vehicle_recall", 55, "important"],
  ["bill_due", 18, "critical"],
  ["warranty_expiring", 12, "useful"],
  ["subscription_renewing", 9, "useful"],
  ["document_expiring", 7, "important"],
];

async function main() {
  if (process.argv.includes("--clean")) {
    await db.delete(schema.attentionItems).where(like(schema.attentionItems.id, `${PREFIX}%`));
    console.log("removed the QA attention rows");
    process.exit(0);
  }

  const target = Number(process.argv[2] ?? 150);
  const rows: Array<Record<string, unknown>> = [];
  let n = 0;

  for (const [reasonCode, count, urgency] of SHAPE) {
    for (let i = 0; i < count && rows.length < target; i++) {
      rows.push({
        id: `${PREFIX}${String(n++).padStart(4, "0")}`,
        ownerUserId: "usr_demo_alex",
        reasonCode,
        reasonText: `${reasonCode.replace(/_/g, " ")} — item ${i + 1}, with a realistically long explanation line that wraps on a phone`,
        urgency,
        confidenceBand: "verified",
        primaryActions: ["view"],
        resolved: false,
        dueAtSort: new Date(Date.now() + (i + 1) * 86_400_000),
        createdAt: new Date(Date.now() - n * 60_000),
        updatedAt: new Date(),
      });
    }
  }
  // The tail: singletons that collapse into nothing, which is the case that decides the answer.
  while (rows.length < target) {
    rows.push({
      id: `${PREFIX}${String(n++).padStart(4, "0")}`,
      ownerUserId: "usr_demo_alex",
      reasonCode: `one_off_${n}`,
      reasonText: `A one-off thing needing attention — ${n}`,
      urgency: "useful",
      confidenceBand: "verified",
      primaryActions: ["view"],
      resolved: false,
      dueAtSort: new Date(Date.now() + n * 3_600_000),
      createdAt: new Date(Date.now() - n * 60_000),
      updatedAt: new Date(),
    });
  }

  await db.insert(schema.attentionItems).values(rows as never).onConflictDoNothing();
  console.log(`inserted ${rows.length} QA attention items (${new Set(rows.map((r) => r.reasonCode)).size} distinct reason codes)`);
  process.exit(0);
}

void main();
