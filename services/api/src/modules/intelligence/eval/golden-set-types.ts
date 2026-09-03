/**
 * §39.2 "Per-domain offline evaluation suites include precision/recall of fields, date/amount exactness
 * ..." — the shape of one hand-authored golden-set fixture (see ./golden-set/*.json). `subject`/`body`
 * mirror exactly what `IngestionService`'s real extractors build their `userContent` from
 * (`Subject: ${subject}\n\nBody:\n${body}`), so a golden case is a realistic email, not a bare fact list.
 *
 * `expected` is a FLAT map of dot-paths to expected leaf values (e.g. `"lineItems.0.quantity": 2`,
 * `"purchaseDate.iso_date": "2026-03-04"` would also be valid, though nested objects/arrays in the JSON
 * fixtures themselves are auto-flattened by `flattenExpected` in ./score.ts — a fixture author can write
 * `"purchaseDate": { "iso_date": "...", "approximate_text": null }` naturally and it's flattened at eval
 * time). Only fields actually present in `expected` are checked — a golden case doesn't have to pin down
 * every field the schema defines, only the ones that matter for that case (§AI-001's own "never invent" /
 * "null when unstated" discipline means a deliberately-absent value is itself a meaningful field, e.g.
 * `"returnDeadline": null`).
 */
export interface GoldenCase {
  id: string;
  subject: string;
  body: string;
  expected: Record<string, unknown>;
}
