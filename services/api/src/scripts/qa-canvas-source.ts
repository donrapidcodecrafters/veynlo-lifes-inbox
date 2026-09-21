/**
 * Put one Canvas school source into the live database so the worker's dispatch can be exercised for real.
 *
 * The end-to-end test already proves `CanvasService.sync` against a real HTTPS server and a real database.
 * What it cannot prove is the thing that changed in `worker-main.ts`: that a queued job for a Canvas
 * source now reaches `SchoolService.syncSchoolSource` and is dispatched by kind, rather than being handed
 * to the ICS service that would quietly do nothing with it.
 *
 * So this seeds a source pointing at a host that resolves publicly and answers nothing. The sync is
 * expected to FAIL — that is the point. A failure recorded against the row proves the job was picked up,
 * routed to the Canvas service, and its error handling ran; a row left untouched at "initializing" would
 * mean the worker never dispatched it at all.
 *
 * Written through the ORM rather than raw SQL because `apiToken`, `apiBaseUrl` and `label` are encrypted
 * columns — a raw INSERT would store readable text in a column everything else reads as ciphertext.
 *
 *   pnpm --filter @veynlo/api exec tsx src/scripts/qa-canvas-source.ts
 */
import { eq } from "drizzle-orm";
import { createDbClient, schema } from "@veynlo/db";
import { generateId } from "@veynlo/core";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const HOUSEHOLD_ID = process.env.QA_HOUSEHOLD_ID ?? "hh_demo_rivera";
const OWNER_USER_ID = process.env.QA_USER_ID ?? "usr_demo_alex";

/**
 * A domain reserved by RFC 2606 for exactly this. It resolves, it is public, and nothing is listening —
 * so the SSRF guard passes it and the request then fails, which is the shape this script needs.
 */
const UNREACHABLE_CANVAS = "https://canvas.example.com";

async function main() {
  const db = createDbClient(DATABASE_URL);

  const existing = await db.select().from(schema.schoolSources).where(eq(schema.schoolSources.householdId, HOUSEHOLD_ID));
  const priorCanvas = existing.filter((s) => s.kind === "canvas");
  for (const row of priorCanvas) {
    await db.delete(schema.schoolSources).where(eq(schema.schoolSources.id, row.id));
  }
  if (priorCanvas.length > 0) console.log(`removed ${priorCanvas.length} previous QA Canvas source(s)`);

  const id = generateId("schoolSource");
  await db.insert(schema.schoolSources).values({
    id,
    householdId: HOUSEHOLD_ID,
    createdByUserId: OWNER_USER_ID,
    label: "QA Canvas (expected to fail)",
    kind: "canvas",
    apiBaseUrl: UNREACHABLE_CANVAS,
    apiToken: "qa-token-not-a-real-credential",
    health: "initializing",
  });

  console.log(`created school source ${id}`);
  console.log(`  kind:   canvas`);
  console.log(`  host:   ${UNREACHABLE_CANVAS}`);
  console.log(`  health: initializing`);
  console.log(`\nNow POST /v1/school/sources/${id}/resync and re-read the row.`);
  console.log("Expected afterwards: health 'degraded', with a healthDetail about the ADDRESS or reachability —");
  console.log("never about a rejected token, which would mean the error classification regressed.");
  process.exit(0);
}

void main();
