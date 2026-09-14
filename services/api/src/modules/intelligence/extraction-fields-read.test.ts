import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Every field we ask a model for is either read by the app, or listed here as deliberately unread.
 *
 * This is the question that found DEF-102: four extraction schemas declared a `startTime`, nothing
 * anywhere read one, and every appointment the app discovered from an email silently lost its time of day.
 * The schema was right, the prompt was right, the model's answer was right — only the last step was
 * missing, which is why it survived months of testing and a week of auditing.
 *
 * It was found by a one-off script. A one-off script finds a defect once; this makes the same question run
 * on every commit, so the NEXT unread field fails here instead of shipping and waiting to be noticed.
 *
 * A declared-but-unread field is always one of three things:
 *
 *   1. a real gap, like DEF-102 — the information is extracted and dropped on the floor;
 *   2. tokens and model attention spent on something nobody wants;
 *   3. a field read through a spread or a dynamic key, which static analysis cannot see.
 *
 * So this does not forbid unread fields. It forbids unread fields that nobody has decided about: adding
 * one means adding it to KNOWN_UNREAD with a reason, which is a thirty-second edit and a permanent record
 * of the decision.
 */

const SCHEMA_FILE = path.join(__dirname, "extraction-schemas.ts");
const SRC_ROOT = path.join(__dirname, "..", "..");

/**
 * Fields that are declared and deliberately not read, with the reason.
 *
 * `confidenceNotes` and `reasoning` are the interesting case: they are never consumed by the app on
 * purpose. Asking a model to state what was ambiguous measurably improves the fields around them — the
 * answer is for the model's own benefit, not ours — and they are also what a human reads when an
 * extraction is being investigated. That is a real use, just not a code path.
 */
const KNOWN_UNREAD: Record<string, string> = {
  "*.confidenceNotes": "asked for the model's benefit — stating what was ambiguous improves the fields around it, and it is what a human reads when investigating an extraction",
  "*.reasoning": "same purpose as confidenceNotes, under the name the classifiers use",
};

/** Each `export const XSchema = z.object({ ... })`, with its top-level field names. */
function schemasWithFields(src: string) {
  const out: Array<{ name: string; fields: string[]; line: number }> = [];
  const re = /export const (\w+Schema) = z\.object\(\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(m.index, i);
    const fields: string[] = [];
    let d = 0;
    for (const line of body.split("\n").slice(1)) {
      const t = line.trim();
      const key = d === 0 ? /^(\w+):\s/.exec(t) : null;
      if (key?.[1]) fields.push(key[1]);
      for (const c of line) {
        if (c === "{" || c === "(" || c === "[") d++;
        else if (c === "}" || c === ")" || c === "]") d--;
      }
    }
    out.push({ name: m[1]!, fields, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}

function productSources(): string {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && p !== SCHEMA_FILE) {
        files.push(p);
      }
    }
  })(SRC_ROOT);
  // Tests are excluded on purpose: a field read only by a test is still unread by the product, which is
  // exactly the case worth surfacing.
  return files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
}

describe("extraction schemas ask only for fields the app reads", () => {
  it("has no unread field that has not been decided about", () => {
    const src = fs.readFileSync(SCHEMA_FILE, "utf8").split("\r\n").join("\n");
    const haystack = productSources();

    const undecided: string[] = [];
    for (const schema of schemasWithFields(src)) {
      for (const field of schema.fields) {
        // `.field` covers result.data.field and any property access; the destructure form is checked too.
        const readAsProperty = new RegExp(`\\.${field}\\b`).test(haystack);
        const readAsDestructure =
          new RegExp(`\\{[^{}]*\\b${field}\\b[^{}]*\\}\\s*=`).test(haystack);
        if (readAsProperty || readAsDestructure) continue;

        const key = `${schema.name}.${field}`;
        if (KNOWN_UNREAD[key] || KNOWN_UNREAD[`*.${field}`]) continue;
        undecided.push(`${key}  (${path.basename(SCHEMA_FILE)}:${schema.line})`);
      }
    }

    expect(
      undecided,
      undecided.length === 0
        ? ""
        : `These fields are asked of a model and never read by the app.\n\n` +
            undecided.map((u) => `  ${u}`).join("\n") +
            `\n\nEach is either a gap like DEF-102 (the information is extracted and dropped), tokens spent ` +
            `on something nobody wants, or a field read dynamically. Decide which, then either read it or ` +
            `add it to KNOWN_UNREAD in this file with the reason.`,
    ).toEqual([]);
  });

  it("does not carry stale exemptions", () => {
    // An exemption for a field that no longer exists is a decision about nothing, and it hides the fact
    // that the schema moved on.
    const src = fs.readFileSync(SCHEMA_FILE, "utf8").split("\r\n").join("\n");
    const schemas = schemasWithFields(src);
    const stale = Object.keys(KNOWN_UNREAD).filter((key) => {
      const [schemaName, fieldName] = key.split(".") as [string, string];
      if (schemaName === "*") return !schemas.some((s) => s.fields.includes(fieldName));
      return !schemas.some((s) => s.name === schemaName && s.fields.includes(fieldName));
    });
    expect(stale, `KNOWN_UNREAD exempts fields that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
