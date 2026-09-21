import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { placeFromMapUrl, titleForPage } from "../public/shared/link-title.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The extension's copy of the maps rule, checked against the shared fixture.
 *
 * The server has the same rule in TypeScript and cannot be imported here — this extension has no bundler.
 * Two copies of one rule is how the provider-label map ended up wrong in six places at once, so neither
 * copy owns the truth: `packages/core/src/link/map-url-cases.json` does, and the server's suite reads the
 * same file. A case added there has to be satisfied on both sides or one of the two builds goes red.
 */
const FIXTURE = path.join(HERE, "..", "..", "..", "packages", "core", "src", "link", "map-url-cases.json");

test("the shared fixture is where this expects it, and is not empty", () => {
  // Guarding the guard. If this file moved, every case below would silently stop running and the suite
  // would pass while measuring nothing — the exact shape of failure this whole audit keeps finding.
  assert.ok(fs.existsSync(FIXTURE), `shared fixture missing at ${FIXTURE}`);
  const { cases } = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.ok(Array.isArray(cases) && cases.length >= 10, `expected the shared cases, found ${cases?.length}`);
});

test("every shared case behaves the same here as on the server", () => {
  const { cases } = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const c of cases) {
    assert.equal(placeFromMapUrl(c.url), c.place, `${c.url}${c.note ? ` — ${c.note}` : ""}`);
  }
});

test("a maps place beats the browser's own title", () => {
  // Measured in a real browser: Google Maps titles every one of its place pages "Google Maps", so without
  // this the extension saves them all under the same name.
  assert.equal(
    titleForPage("https://www.google.com/maps/place/Blue+Bottle+Coffee", "Google Maps"),
    "Blue Bottle Coffee",
  );
});

test("the browser's title wins everywhere else", () => {
  // This is the extension's advantage over a server fetch and must not be given up: the browser has
  // already run the page's JavaScript, so its title for a TikTok video IS the video.
  assert.equal(titleForPage("https://www.tiktok.com/@tiktok", "TikTok (@tiktok) | TikTok"), "TikTok (@tiktok) | TikTok");
  assert.equal(titleForPage("https://example.com/recipes/sourdough", "Overnight Sourdough"), "Overnight Sourdough");
});

test("a page with no title at all falls back to its URL", () => {
  assert.equal(titleForPage("https://example.com/x", ""), "https://example.com/x");
  assert.equal(titleForPage("https://example.com/x", "   "), "https://example.com/x");
  assert.equal(titleForPage("https://example.com/x", undefined), "https://example.com/x");
});
