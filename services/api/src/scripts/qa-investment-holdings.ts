/**
 * FIN-006 "Investments" QA fixture — a brokerage account with real-shaped positions for the demo user.
 *
 * Seeded through the ORM, never raw SQL: `financial_accounts.name` is an `encryptedText` column, so a raw
 * INSERT renders in the UI as "[content unavailable — decryption failed]" and every assertion about the
 * screen becomes meaningless. That mistake has already been made twice in this audit; this note is here so
 * it is not made a third time.
 *
 * Deliberately mixed data, because the interesting rendering cases are the incomplete ones:
 *   - a fractional equity position (12.34567890 shares) — proves the UI does not round a real holding away
 *   - a mutual fund with a clean round quantity
 *   - a cash-equivalent position
 *   - a position with NO cost basis, which must render as an absent gain rather than a fabricated one
 *   - an EXCLUDED second account, whose positions show but must not reach the portfolio total
 *
 *   cd services/api && npx tsx src/scripts/qa-investment-holdings.ts
 */
import { createDbClient, schema } from "@veynlo/db";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const OWNER = "usr_demo_alex";

const CONNECTION_ID = "conn_qa_investments";
const ACCOUNT_ID = "facct_qa_brokerage";
const EXCLUDED_ACCOUNT_ID = "facct_qa_joint_brokerage";

const SECURITIES = [
  { id: "sec_qa_aapl", ticker: "AAPL", name: "Apple Inc.", type: "equity", close: "187.660000", cash: false },
  { id: "sec_qa_bmifx", ticker: "BMIFX", name: "Broad Market Index Fund", type: "mutual fund", close: "42.105000", cash: false },
  { id: "sec_qa_usd", ticker: "USD", name: "US Dollar", type: "cash", close: "1.000000", cash: true },
  { id: "sec_qa_esp", ticker: null, name: "Employer Stock Plan", type: "equity", close: null, cash: false },
];

const HOLDINGS = [
  {
    id: "hold_qa_aapl",
    accountId: ACCOUNT_ID,
    securityId: "sec_qa_aapl",
    quantity: "12.34567890",
    price: "187.655000",
    value: 231_679,
    basis: 150_000,
  },
  {
    id: "hold_qa_bmifx",
    accountId: ACCOUNT_ID,
    securityId: "sec_qa_bmifx",
    quantity: "100.00000000",
    price: "42.105000",
    value: 421_05,
    basis: 400_00,
  },
  {
    id: "hold_qa_usd",
    accountId: ACCOUNT_ID,
    securityId: "sec_qa_usd",
    quantity: "431.22000000",
    price: "1.000000",
    value: 431_22,
    basis: 431_22,
  },
  {
    // No cost basis — the "withhold, never guess" case.
    id: "hold_qa_esp",
    accountId: ACCOUNT_ID,
    securityId: "sec_qa_esp",
    quantity: "250.00000000",
    price: null,
    value: 1_875_00,
    basis: null,
  },
  {
    // Excluded account — listed, never summed. The largest number in the fixture on purpose.
    id: "hold_qa_joint_aapl",
    accountId: EXCLUDED_ACCOUNT_ID,
    securityId: "sec_qa_aapl",
    quantity: "500.00000000",
    price: "187.655000",
    value: 9_382_750,
    basis: 5_000_000,
  },
];

async function main() {
  const db = createDbClient(DATABASE_URL);

  const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, OWNER)).limit(1);
  if (!owner) {
    console.error(`${OWNER} does not exist — run the main seed first (pnpm --filter @veynlo/db run seed).`);
    process.exit(1);
  }

  await db
    .insert(schema.connections)
    .values({
      id: CONNECTION_ID,
      ownerUserId: OWNER,
      provider: "plaid",
      feasibilityClass: "aggregator",
      scopes: ["transactions", "liabilities", "investments"],
      enabledCategories: ["purchases", "bills"],
      health: "healthy",
    })
    .onConflictDoNothing();

  for (const account of [
    { id: ACCOUNT_ID, name: "Fidelity Individual Brokerage", subtype: "brokerage", included: true, balance: 2_316_79 + 421_05 + 431_22 + 1_875_00 },
    { id: EXCLUDED_ACCOUNT_ID, name: "Joint Brokerage (excluded)", subtype: "brokerage", included: false, balance: 9_382_750 },
  ]) {
    await db
      .insert(schema.financialAccounts)
      .values({
        id: account.id,
        connectionId: CONNECTION_ID,
        ownerUserId: OWNER,
        plaidAccountId: `plaid-${account.id}`,
        name: account.name,
        type: "investment",
        subtype: account.subtype,
        mask: account.id.slice(-4),
        currentBalanceMinorUnits: account.balance,
        currency: "USD",
        isIncluded: account.included,
      })
      .onConflictDoNothing();
  }

  for (const s of SECURITIES) {
    await db
      .insert(schema.securities)
      .values({
        id: s.id,
        ownerUserId: OWNER,
        plaidSecurityId: `plaid-${s.id}`,
        name: s.name,
        tickerSymbol: s.ticker,
        type: s.type,
        closePrice: s.close,
        closePriceAsOf: s.close ? new Date().toISOString().slice(0, 10) : null,
        currency: "USD",
        isCashEquivalent: s.cash,
      })
      .onConflictDoNothing();
  }

  for (const h of HOLDINGS) {
    await db
      .insert(schema.investmentHoldings)
      .values({
        id: h.id,
        accountId: h.accountId,
        ownerUserId: OWNER,
        securityId: h.securityId,
        quantity: h.quantity,
        institutionPrice: h.price,
        institutionPriceAsOf: h.price ? new Date().toISOString().slice(0, 10) : null,
        institutionValueMinorUnits: h.value,
        costBasisMinorUnits: h.basis,
        currency: "USD",
      })
      .onConflictDoNothing();
  }

  const rows = await db.select().from(schema.investmentHoldings).where(eq(schema.investmentHoldings.ownerUserId, OWNER));
  console.log(`seeded ${rows.length} holding(s) across 2 investment accounts for ${OWNER}`);
  console.log(`  included account : ${ACCOUNT_ID} (4 positions, one with no cost basis)`);
  console.log(`  excluded account : ${EXCLUDED_ACCOUNT_ID} (1 position, must not reach the total)`);
  process.exit(0);
}

void main();
