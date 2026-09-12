/**
 * Decides whether a fixture failure is a reason to SKIP, or a bug to fail on.
 *
 * Nearly every database-backed suite in this service opens with the same shape: build a fixture in
 * `beforeAll`, and on any error set `dbAvailable = false` so each test returns early. The intent is good —
 * a developer with no local Postgres should not see a hundred red suites — but the catch swallowed
 * *everything*, so a fixture that violated a NOT NULL constraint, referenced a column that had been
 * renamed, or hit an authorization error was indistinguishable from a missing database. Those suites
 * reported PASSED while running none of their assertions.
 *
 * That is not hypothetical. The Inbox pagination suite was written, reported five passing tests, and was
 * then "proved" by deliberately breaking the cursor it tested — and it still reported five passing tests,
 * because its fixture had failed on a missing `content_hash` and every test was returning at the first
 * line. 169 of this service's 173 database-backed suites had the same hole.
 *
 * A green suite that ran nothing is worse than a red one: it is counted as evidence.
 *
 * So: only a genuinely unreachable database is a skip. Anything else is rethrown, loudly, where it belongs.
 */

/**
 * Errors that mean "there is no database here", as opposed to "this fixture is wrong".
 *
 * Deliberately matched on connection-level failures only. A constraint violation, a missing column, a
 * type error — all of those mean the database answered and rejected what we sent it, which is a defect in
 * the test, not in the environment.
 */
const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ETIMEDOUT|Connection terminated|connection refused|timeout expired|Client has encountered a connection error|database system is starting up|too many clients/i;

/**
 * Call from a fixture's `catch`. Returns `false` (meaning "not available, skip") only when the database is
 * genuinely unreachable; otherwise rethrows so the broken fixture fails the suite.
 *
 *     } catch (err) {
 *       dbAvailable = skipIfDatabaseUnreachable(err, "AuthGuard suspended-account tests");
 *     }
 */
export function skipIfDatabaseUnreachable(err: unknown, label: string): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (!UNREACHABLE.test(message)) throw err;
  console.warn(`Skipping ${label} — no reachable dev Postgres: ${message}`);
  return false;
}
