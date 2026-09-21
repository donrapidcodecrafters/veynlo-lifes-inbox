#!/usr/bin/env node
/**
 * Assemble the Firefox build of the extension.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why a second build rather than one manifest for both
 * ---------------------------------------------------------------------------------------------------
 * Chromium and Firefox disagree on exactly two things here, and neither can be expressed once:
 *
 *   background      Chromium MV3 requires `service_worker`. Firefox MV3 runs the background as an event
 *                   page and wants `scripts`. A manifest carrying both is ambiguous, and the pair is not
 *                   portable.
 *
 *   extension id    Firefox needs `browser_specific_settings.gecko.id` to install or sign an MV3
 *                   extension at all. Chromium has no equivalent and warns about the unknown key.
 *
 * Everything else — every line of JavaScript, every asset — is shared verbatim. The extension's code uses
 * only APIs Firefox implements under the same `chrome.*` namespace (action, contextMenus, runtime,
 * scripting, storage, tabs), so there is no compatibility shim and nothing to keep in step by hand.
 *
 * ---------------------------------------------------------------------------------------------------
 * One difference that is NOT cosmetic
 * ---------------------------------------------------------------------------------------------------
 * In Firefox MV3, `host_permissions` are OPTIONAL: they are not granted at install time and the user
 * turns them on per site. So a fresh Firefox install can have the extension apparently working and the
 * save refused by the browser until the host is allowed. The extension already surfaces a failed save
 * rather than swallowing it, which is the behaviour that matters — but it is a real difference in
 * first-run experience, recorded here rather than discovered later.
 *
 *   node scripts/build-firefox.mjs        # writes dist/firefox/
 *   pnpm run lint:firefox                 # builds, then runs Mozilla's own validator over the result
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SOURCE = path.join(ROOT, "public");
const OUT = path.join(ROOT, "dist", "firefox");
const FIREFOX_MANIFEST = path.join(ROOT, "manifest.firefox.json");

/** Copy a directory tree, skipping the Chromium manifest — the Firefox one replaces it. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else if (entry.name !== "manifest.json") fs.copyFileSync(src, dest);
  }
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`No source at ${SOURCE}`);
    process.exit(1);
  }
  if (!fs.existsSync(FIREFOX_MANIFEST)) {
    console.error(`No Firefox manifest at ${FIREFOX_MANIFEST}`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  copyTree(SOURCE, OUT);
  fs.copyFileSync(FIREFOX_MANIFEST, path.join(OUT, "manifest.json"));

  // The two manifests must stay in step on everything except the keys that genuinely differ. Checked here
  // rather than trusted: they are separate files and will drift the moment one is edited alone — the same
  // failure the provider-label map had in six places at once.
  const chromium = JSON.parse(fs.readFileSync(path.join(SOURCE, "manifest.json"), "utf8"));
  const firefox = JSON.parse(fs.readFileSync(FIREFOX_MANIFEST, "utf8"));
  const mustMatch = ["manifest_version", "name", "version", "description", "permissions", "host_permissions", "icons", "action"];
  const drifted = mustMatch.filter((key) => JSON.stringify(chromium[key]) !== JSON.stringify(firefox[key]));
  if (drifted.length > 0) {
    console.error(`The two manifests disagree on: ${drifted.join(", ")}`);
    console.error("Only `background`, `browser_specific_settings` and the options key may differ.");
    process.exit(1);
  }

  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(OUT, full).split(path.sep).join("/"));
    }
  })(OUT);

  console.log(`Firefox build written to ${path.relative(ROOT, OUT)}`);
  for (const file of files.sort()) console.log(`  ${file}`);
  console.log(`\nLoad it with about:debugging → This Firefox → Load Temporary Add-on → ${path.join(OUT, "manifest.json")}`);
}

main();
