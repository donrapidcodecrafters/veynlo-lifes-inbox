/**
 * Seed an Inbox at realistic DEPTH, through the product's own encrypted write path.
 *
 * The fixture has two inbox items. DEF-104 and DEF-105 were both invisible to every sweep for exactly this
 * reason: the seed was built for BREADTH — every area populated so no screen is empty — and nothing
 * populated deeply. A screen that is correct at 2 rows and unusable at 65 looks perfect in every screenshot
 * this audit has taken.
 *
 * So before changing the Inbox, give it something that can actually show the problem. Written through
 * Drizzle rather than raw SQL because `summary` is an encryptedText column — a previous attempt wrote
 * plaintext and every row rendered "[content unavailable — decryption failed]", which was the app degrading
 * correctly against a fixture that lied.
 *
 * Deleted with:  DELETE FROM inbox_items WHERE id LIKE 'inb_depth_%';
 */
import { createDbClient, schema } from "@veynlo/db";

const db = createDbClient(process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo");

// Realistic content, not "item 1" — layout defects hide behind short placeholder text, and several of
// these are deliberately long enough to wrap on a phone.
const SEED: Array<[string, string[]]> = [
  ["purchase", [
    "Amazon order #114-2938471 — Dyson V15 Detect cordless vacuum, $749.99, arriving Thursday",
    "REI order #RE-88213 — Patagonia Nano Puff jacket, $229.00",
    "Best Buy order #BBY01-80429 — Sony WH-1000XM5 headphones, $399.99",
    "Amazon order #114-3847192 — replacement HEPA filters, 2-pack, $39.98",
    "Home Depot order #WM-77341 — gutter guards, 40ft, $184.50",
    "Amazon order #114-9928374 — USB-C cables, 3-pack, $24.99",
    "Target order #TGT-4482910 — winter boots, youth size 5, $64.99",
    "Backcountry order #BC-338290 — trekking poles, $119.95",
  ]],
  ["bill", [
    "ComEd electricity bill — $84.20 due September 17",
    "Xfinity internet bill — $99.00 due September 19",
    "State Farm auto insurance — $212.00 due September 22",
    "Chicago Water Department — $61.40 due September 25",
    "Nicor Gas — $38.75 due September 28",
    "Lincoln Elementary lunch account top-up — $45.00 due October 1",
  ]],
  ["appointment", [
    "Dr. Alvarez follow-up — October 3, 9:30 AM, Riverside Medical",
    "Maya's parent-teacher conference — September 24, 4:15 PM, Lincoln Elementary",
    "Biscuit's annual vet checkup — October 8, 11:00 AM, Oak Park Animal Hospital",
    "Dental cleaning, both kids — October 15, 3:00 PM and 3:45 PM",
    "Subaru 60,000 mile service — September 30, 8:00 AM",
  ]],
  ["document", [
    "Homeowner's insurance policy renewal — State Farm, effective November 1",
    "Maya's immunisation record — Lincoln Elementary, uploaded by the school nurse",
    "2025 property tax assessment — Cook County",
    "Passport renewal confirmation — application #PR-2938471",
  ]],
  ["travel", [
    "United flight UA482 — Denver, October 14, departing 7:15 AM from ORD",
    "Hyatt Place Denver Downtown — October 14 to 18, confirmation HY-88392",
    "Hertz rental car — Denver Airport, October 14, confirmation HZ-44821",
  ]],
  ["warranty", [
    "Dyson V15 warranty registration — 2-year coverage through August 2027",
    "Sony WH-1000XM5 — 1-year manufacturer warranty registered",
  ]],
];

const rows = [];
let n = 0;
for (const [category, summaries] of SEED) {
  for (const summary of summaries) {
    rows.push({
      id: `inb_depth_${n}`,
      ownerUserId: "usr_demo_alex",
      // NOT NULL — every inbox item is traceable to the evidence it came from, which is the point of the
      // column. Reusing a real seeded source event rather than inventing one keeps that true.
      sourceEventId: "src_demo_laptop_receipt",
      category,
      summary,
      // The Inbox DEFAULT view is reviewState=new — that is the screen a user actually lands on. The
      // first version of this fixture produced only "needs_review" and "auto_filed", so the default view
      // still held the original 2 items and every sweep that "tested the Inbox" tested a 2-item page.
      // A real inbox is mostly unreviewed, so most of these are new, with the other two states present
      // so their badges and the "all" filter have something to show.
      reviewState: n % 5 === 3 ? ("needs_review" as const) : n % 5 === 4 ? ("auto_filed" as const) : ("new" as const),
      confidenceBand: "verified",
      // Every NOT NULL column, taken from information_schema rather than discovered one failed insert at a
      // time — which is what the first three attempts did.
      suggestedActions: category === "bill" ? ["confirm", "dismiss"] : ["confirm"],
      autoFiled: n % 5 === 4,
      createdAt: new Date(Date.now() - n * 3_600_000),
      updatedAt: new Date(),
    });
    n++;
  }
}

db.insert(schema.inboxItems)
  .values(rows as never)
  .onConflictDoNothing()
  .then(() => {
    console.log(`seeded ${rows.length} inbox items across ${SEED.length} categories, through the encrypted write path`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
