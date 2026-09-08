import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A guard, not a unit test: nothing may compare or order an encrypted column in SQL.
 *
 * `encryptedText`/`encryptedJsonb` store AES-256-GCM ciphertext and Drizzle only decrypts on the way out
 * (`fromDriver`), while `encryptField` picks a fresh random IV per write. So in SQL those columns support
 * neither comparison nor ordering, and both failures are silent:
 *
 *  - `eq(col, "Biscuit")` compares a plaintext string against ciphertext and matches nothing. Google and
 *    Microsoft contact sync both deduped on `contactSources.providerContactId` this way, so no sync ever
 *    found the row it had written last time: every run re-imported the whole address book as new people,
 *    with the update and deletion branches unreachable. Organizations duplicated identically on
 *    `organizations.name`. Proven against the real database inside a rolled-back transaction — the row
 *    reads back with exactly the value written, and a query for that value returns nothing.
 *  - `orderBy(col)` sorts ciphertext: a random permutation that reshuffles on every write. Seven list
 *    endpoints did this; pets came back `Biscuit | Marmalade | Biscuit`.
 *
 * Neither shows up as an error, a warning, or a failing test — only as wrong data — so the protection has
 * to be a rule about the code. Reads that do not depend on contents (`isNull`, selecting the column,
 * inserting into it) are fine and are not matched here.
 *
 * The column pattern below matches `encryptedJsonb<T>(...)` as well as `encryptedText(...)`. It did not
 * at first — `encrypted(?:Text|Json)\s*\(` cannot match `encryptedJsonb<string[]>(`, because of the
 * trailing `b` and the generic — so all 16 encrypted JSON columns were invisible to this guard and to
 * the two scanners it came from, which reported 119 columns rather than 133. Nothing was actually
 * offending in those 16, but the guard would have said so either way. That is the same failure I had
 * just written up twice: a scanner does not report what it never looks at, and a clean result from an
 * incomplete scan is indistinguishable from a clean result.
 */
const REPO = path.join(__dirname, "..", "..", "..", "..");
const SCHEMA_DIR = path.join(REPO, "packages", "db", "src", "schema");
const SERVICES = path.join(REPO, "services", "api", "src");

/** table export name -> encrypted property names */
function encryptedColumns(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>();
  for (const file of fs.readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(SCHEMA_DIR, file), "utf8");
    const starts: Array<{ name: string; at: number }> = [];
    const tableRe = /export const (\w+)\s*=\s*pgTable\(/g;
    let m: RegExpExecArray | null;
    while ((m = tableRe.exec(src)) !== null) starts.push({ name: m[1]!, at: m.index });
    for (let i = 0; i < starts.length; i++) {
      const body = src.slice(starts[i]!.at, i + 1 < starts.length ? starts[i + 1]!.at : src.length);
      const cols = new Set<string>();
      const colRe = /(\w+)\s*:\s*encrypted(?:Text|Jsonb?)\s*[<(]/g;
      let c: RegExpExecArray | null;
      while ((c = colRe.exec(body)) !== null) cols.add(c[1]!);
      if (cols.size) byTable.set(starts[i]!.name, cols);
    }
  }
  return byTable;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const CONTENT_DEPENDENT = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "notLike",
  "notIlike",
  "inArray",
  "notInArray",
  "between",
  "asc",
  "desc",
];

function offences(): string[] {
  const encrypted = encryptedColumns();
  const found: string[] = [];
  for (const file of walk(SERVICES)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const fn of CONTENT_DEPENDENT) {
        // String.raw, not a plain template literal. In a normal one the regex escapes are consumed by the
        // string before the regex ever sees them, which built an unterminated group and THREW rather than
        // matching anything. A guard that throws is not a guard.
        const re = new RegExp(String.raw`\b${fn}\s*\(\s*schema\.(\w+)\.(\w+)`, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (encrypted.get(m[1]!)?.has(m[2]!)) {
            found.push(`${path.relative(REPO, file).split(path.sep).join("/")}:${i + 1} — ${fn}(${m[1]}.${m[2]}, …)`);
          }
        }
      }
    });
  }
  return found;
}

describe("encrypted columns are never compared or ordered in SQL", () => {
  it("finds the encrypted columns it is meant to guard, so a broken scan cannot pass vacuously", () => {
    const encrypted = encryptedColumns();
    const total = [...encrypted.values()].reduce((n, s) => n + s.size, 0);
    expect(total).toBeGreaterThan(50);
    expect(encrypted.get("petProfiles")?.has("label")).toBe(true);
    expect(encrypted.get("contactSources")?.has("providerContactId")).toBe(true);
  });

  it("matches a comparison when there genuinely is one, so the guard is known to be able to fail", () => {
    // Same regex the guard uses, against a line that definitely offends.
    const line = 'eq(schema.petProfiles.label, "Biscuit")';
    const re = new RegExp(String.raw`\beq\s*\(\s*schema\.(\w+)\.(\w+)`, "g");
    const m = re.exec(line);
    expect(m?.[1]).toBe("petProfiles");
    expect(m?.[2]).toBe("label");
  });

  it("no service compares or orders one", () => {
    expect(offences()).toEqual([]);
  });
});
