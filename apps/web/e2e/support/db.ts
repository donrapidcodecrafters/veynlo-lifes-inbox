import { execFileSync } from "node:child_process";

/**
 * Same default every services/api Postgres integration test uses (see e.g.
 * services/api/src/modules/commerce/commerce.purchase-lifecycle.test.ts) — overridable for CI/non-default
 * setups exactly like API_BASE_URL/E2E_WEB_URL above.
 *
 * Direct SQL, not `@veynlo/db`'s Drizzle client — apps/web has no workspace dependency on `@veynlo/db` (it
 * only ever talks to services/api over HTTP, by design), and there's no real API endpoint to create a
 * purchase in a specific lifecycle state (purchases only ever come from AI extraction — see
 * CommerceService's own doc comments) the way `POST /v1/subscriptions` exists for subscriptions. Raw SQL
 * via `psql` is the smallest way to seed exactly the one row this spec needs without adding a new
 * cross-package dependency just for test setup.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/** Runs one SQL statement against the real dev Postgres via the `psql` CLI. Throws with psql's own stderr on failure, so a broken seed fails the spec loudly rather than silently leaving no test fixture behind. */
export function execSql(sql: string): void {
  execFileSync("psql", [DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Seeds a `candidate`-state purchase directly for one owner — the one lifecycle-state combination this
 * spec needs (CommerceService.confirmPurchase's real `candidate -> confirmed` transition) that has no
 * reachable API path to create. `needs_review` confidence keeps it out of
 * `scanAndAdvancePurchaseLifecycle`'s auto-confirm band (PURCHASE_AUTO_CONFIRM_BANDS) — not that anything
 * currently runs that scan against this dev stack (see that method's own doc comment: it's not wired into
 * a live cron yet), but this keeps the fixture correct regardless.
 */
export function seedCandidatePurchase(ownerUserId: string, id: string, orderNumber: string): void {
  execSql(
    `INSERT INTO purchases (id, owner_user_id, order_number, purchase_date, purchase_date_sort, total_minor_units, total_currency, state, confidence_band) ` +
      `VALUES ('${id}', '${ownerUserId}', '${orderNumber}', '{"precision":"date","instantUtc":null,"date":"2026-08-01","timezone":null,"sourceText":null}', '2026-08-01T00:00:00Z', 5000, 'USD', 'candidate', 'needs_review');`,
  );
}
