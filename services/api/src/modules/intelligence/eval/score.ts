/**
 * §39.2 "Per-domain offline evaluation suites include precision/recall of fields, date/amount exactness
 * ..." — pure, dependency-free scoring logic for one golden-set case: compares the schema's actual
 * extracted output against a golden case's expected fields, field by field. Deliberately has NO Anthropic
 * SDK / DB import — this is the part of the eval harness that's fast, free, and safe to run in the default
 * `vitest` suite (see score.test.ts), unlike run-golden-set-eval.ts, which makes real billable API calls.
 */

/** Flattens a nested expected-value object/array into dot-path leaves, e.g. `{ a: { b: 1 } }` ->
 * `[["a.b", 1]]`, `{ items: [{ x: 1 }] }` -> `[["items.0.x", 1]]`. A `null`/primitive/empty-object/
 * empty-array value is its own leaf — this is what lets a fixture assert `"returnDeadline": null` as a
 * single meaningful field rather than needing to enumerate a null date's own sub-fields. */
export function flattenExpected(value: unknown, prefix = ""): Array<[string, unknown]> {
  if (value === null || value === undefined) return [[prefix, value]];
  if (Array.isArray(value)) {
    if (value.length === 0) return [[prefix, value]];
    return value.flatMap((item, i) => flattenExpected(item, prefix ? `${prefix}.${i}` : `${i}`));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [[prefix, value]];
    return entries.flatMap(([key, v]) => flattenExpected(v, prefix ? `${prefix}.${key}` : key));
  }
  return [[prefix, value]];
}

/** Reads a dot-path (e.g. `"lineItems.0.quantity"`) out of an actual extraction result. Returns `undefined`
 * for a missing/out-of-range segment rather than throwing — a genuinely missing field is exactly the kind
 * of mismatch this harness needs to surface as a failure, not crash on. */
export function getAtPath(obj: unknown, path: string): unknown {
  if (path === "") return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Field-value equality. Numbers/booleans/null use strict equality — an amount or a boolean flag has
 * exactly one correct value, so "close enough" would hide a real extraction error. Strings use a
 * normalized (trimmed, case-insensitive) equality-OR-containment check: a free-text field like a title or
 * merchant name legitimately varies in minor wording/capitalization between two individually-correct
 * extractions (e.g. "TitanTech 65\" 4K TV" vs "TitanTech 65-inch 4K TV"), and this harness's job is to catch
 * a genuinely WRONG value, not to demand byte-for-byte phrasing.
 */
export function valuesMatch(expected: unknown, actual: unknown): boolean {
  if (expected === null) return actual === null;
  if (typeof expected === "string") {
    if (typeof actual !== "string") return false;
    const e = expected.trim().toLowerCase();
    const a = actual.trim().toLowerCase();
    if (e.length === 0 || a.length === 0) return e === a;
    return e === a || a.includes(e) || e.includes(a);
  }
  return expected === actual;
}

export interface FieldResult {
  field: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export interface CaseResult {
  caseId: string;
  schemaName: string;
  pass: boolean;
  fields: FieldResult[];
}

/** Scores one golden case: every dot-path in `expected` is checked against the same path in `actual`. A
 * case passes only if every specified field matches — fields the fixture doesn't mention are never
 * checked (see GoldenCase's own doc comment for why that's deliberate, not an oversight). */
export function scoreCase(caseId: string, schemaName: string, expected: Record<string, unknown>, actual: Record<string, unknown>): CaseResult {
  const fields: FieldResult[] = flattenExpected(expected).map(([field, expectedValue]) => {
    const actualValue = getAtPath(actual, field);
    return { field, expected: expectedValue, actual: actualValue, pass: valuesMatch(expectedValue, actualValue) };
  });
  return { caseId, schemaName, pass: fields.every((f) => f.pass), fields };
}
