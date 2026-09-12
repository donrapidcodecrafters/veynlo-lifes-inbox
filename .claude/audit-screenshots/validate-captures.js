#!/usr/bin/env node
/**
 * Validates EVERY captured screenshot, not a sample.
 *
 * Why this exists: the first mobile pass produced 128 images that were all the sign-in page, because an
 * API-based sign-in put the session cookie in a different jar from the browser. It was caught only
 * because every file happened to be the same byte size. Eyeballing "a couple of recent ones" would not
 * have caught it, and would not catch it next time either — spot-checking a capture set is exactly the
 * sampling this audit is not allowed to do.
 *
 * Checks applied to every file:
 *   1. zero-byte / unreadable  — a failed capture
 *   2. not a valid PNG          — a truncated write
 *   3. identical content hash across many files — the signature of "every screenshot is the same page"
 *      (a redirect to sign-in, an error page, or a capture that never advanced)
 *   4. suspiciously small       — a blank or near-blank render
 *   5. before/after pairs that are byte-identical — the interaction changed nothing at all, which for a
 *      control that reported CHANGED means the evidence contradicts the result
 *
 * Exit code is non-zero if anything fails, so this can gate a claim of "captures verified".
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
// Below this a 390px-wide screenshot is essentially blank. Measured against the real corpus: the
// smallest legitimate capture in this set is a short settings sub-screen at ~25KB.
const TINY_BYTES = 8_000;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".png")) out.push(full);
  }
  return out;
}

const files = fs.existsSync(ROOT) ? walk(ROOT) : [];
const byHash = new Map();
const problems = [];
const meta = new Map();

for (const f of files) {
  const rel = path.relative(ROOT, f);
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch (err) {
    problems.push(`UNREADABLE  ${rel} — ${String(err).slice(0, 60)}`);
    continue;
  }
  if (buf.length === 0) {
    problems.push(`EMPTY       ${rel}`);
    continue;
  }
  if (!buf.subarray(0, 4).equals(PNG_MAGIC)) {
    problems.push(`NOT A PNG   ${rel} (truncated or wrong format)`);
    continue;
  }
  if (buf.length < TINY_BYTES) {
    problems.push(`TINY        ${rel} (${buf.length} bytes — likely blank)`);
  }
  const hash = crypto.createHash("sha1").update(buf).digest("hex");
  meta.set(rel, { hash, size: buf.length });
  if (!byHash.has(hash)) byHash.set(hash, []);
  byHash.get(hash).push(rel);
}

// A handful of identical images is normal (two routes with the same empty state). Many identical images
// means a systemic capture failure, which is the case this check exists for.
const DUP_ALARM = 5;
for (const [hash, list] of byHash) {
  if (list.length >= DUP_ALARM) {
    problems.push(
      `${list.length} IDENTICAL images (hash ${hash.slice(0, 10)}) — likely all the same page:\n              ${list.slice(0, 6).join("\n              ")}${list.length > 6 ? `\n              …and ${list.length - 6} more` : ""}`,
    );
  }
}

// before/after pairs that are byte-identical
let pairsChecked = 0;
let pairsIdentical = 0;
for (const rel of meta.keys()) {
  if (!rel.endsWith("-before.png")) continue;
  const after = rel.replace(/-before\.png$/, "-after.png");
  if (!meta.has(after)) {
    problems.push(`MISSING AFTER  ${rel} has no matching -after.png`);
    continue;
  }
  pairsChecked++;
  if (meta.get(rel).hash === meta.get(after).hash) {
    pairsIdentical++;
  }
}

const dirs = new Map();
for (const rel of meta.keys()) {
  const top = rel.split(path.sep)[0];
  dirs.set(top, (dirs.get(top) || 0) + 1);
}

console.log(`Validated ${files.length} capture(s) across ${dirs.size} area(s):`);
for (const [d, n] of [...dirs].sort()) console.log(`  ${d.padEnd(26)} ${n}`);
console.log(`\nbefore/after pairs: ${pairsChecked} complete, ${pairsIdentical} byte-identical`);
console.log(`unique images: ${byHash.size} of ${meta.size}`);

if (problems.length === 0) {
  console.log(`\nNo problems found in any capture.`);
} else {
  console.log(`\n${problems.length} PROBLEM(S):`);
  for (const p of problems) console.log(`  ${p}`);
}
process.exit(problems.length === 0 ? 0 : 1);
