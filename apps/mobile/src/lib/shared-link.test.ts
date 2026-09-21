// Same setup as offline-mutation-queue.test.ts and push-deep-link.test.ts — Node's built-in runner via
// `tsx --test`, loading the module under test through CommonJS interop. See that file's header for why
// this app tests that way rather than pulling in jest/vitest.
//
// shared-link.ts is deliberately pure (no expo-router, no React, no native module), which is what makes it
// testable here at all.
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate: this suite runs under `tsx --test`,
   i.e. Node's own test runner rather than a bundler, and loads the module under test through CommonJS on
   purpose. Rewriting these as ESM imports would change what is actually being exercised. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { splitSharedLink }: typeof import("./shared-link") = require("./shared-link.ts");

/**
 * Sharing a link into Veynlo filed an item called "Shared text" — every time, for every app.
 *
 * Six of Appendix A's browser/social targets and four of its maps targets arrive through the OS share
 * sheet, so all ten were useless on a phone no matter how well the server could describe the link. This is
 * the part that finds the link inside what was shared.
 */

test("a bare URL is the whole share", () => {
  const found = splitSharedLink("https://www.youtube.com/watch?v=abc");
  assert.equal(found?.url, "https://www.youtube.com/watch?v=abc");
  assert.equal(found?.note, null);
});

test("surrounding whitespace is not part of the link", () => {
  assert.equal(splitSharedLink("  https://example.com/x  ")?.url, "https://example.com/x");
});

test("a caption shared with the link is kept", () => {
  // This is what TikTok actually sends — a line of text and then the link. That text is frequently the
  // only part that says why somebody saved it.
  const found = splitSharedLink("Check out this video on TikTok https://vm.tiktok.com/ZMabc/");
  assert.equal(found?.url, "https://vm.tiktok.com/ZMabc/");
  assert.equal(found?.note, "Check out this video on TikTok");
});

test("a note written after the link is kept too", () => {
  const found = splitSharedLink("https://www.opentable.com/r/x for Saturday?");
  assert.equal(found?.url, "https://www.opentable.com/r/x");
  assert.equal(found?.note, "for Saturday?");
});

test("text on both sides of the link is kept as one note", () => {
  const found = splitSharedLink("dinner here https://example.com/r/x maybe 8pm");
  assert.equal(found?.url, "https://example.com/r/x");
  assert.equal(found?.note, "dinner here maybe 8pm");
});

test("a full stop ending the sentence is not part of the URL", () => {
  // "https://example.com/x." fetches a path ending in a full stop and 404s — a saved link that cannot be
  // opened is worse than one that was never resolved.
  assert.equal(splitSharedLink("look at https://example.com/x.")?.url, "https://example.com/x");
  assert.equal(splitSharedLink("see https://example.com/x, then reply")?.url, "https://example.com/x");
  assert.equal(splitSharedLink("(https://example.com/x)")?.url, "https://example.com/x");
});

test("a bracket that belongs to the URL is kept", () => {
  // Wikipedia puts brackets in paths, and trimming one breaks the link.
  assert.equal(
    splitSharedLink("https://en.wikipedia.org/wiki/Mercury_(planet)")?.url,
    "https://en.wikipedia.org/wiki/Mercury_(planet)",
  );
});

test("a query string survives intact", () => {
  const found = splitSharedLink("https://www.google.com/maps/place/Blue+Bottle?hl=en&z=17");
  assert.equal(found?.url, "https://www.google.com/maps/place/Blue+Bottle?hl=en&z=17");
});

test("plain text with no link stays plain text", () => {
  // Sharing a sentence is a normal thing to do and must keep working exactly as before.
  assert.equal(splitSharedLink("remember to book the dentist"), null);
  assert.equal(splitSharedLink(""), null);
  assert.equal(splitSharedLink("   "), null);
});

test("a scheme this app cannot fetch is not treated as a link", () => {
  // A share can carry mailto:, tel:, geo: or an app's own scheme. None of those is a page to describe, and
  // sending one to the URL endpoint would produce an error where plain-text capture would have worked.
  assert.equal(splitSharedLink("mailto:someone@example.com"), null);
  assert.equal(splitSharedLink("tel:+15551234567"), null);
  assert.equal(splitSharedLink("geo:40.7,-74.0"), null);
  assert.equal(splitSharedLink("veynlo://capture"), null);
});

test("something that merely looks like a URL is not one", () => {
  assert.equal(splitSharedLink("http://localhost"), null, "no dot in the hostname");
  assert.equal(splitSharedLink("https://"), null);
});

test("the FIRST link wins when several are shared", () => {
  // Deliberate and worth stating: describing one link is the job. The others stay in the note, so nothing
  // the user shared is thrown away.
  const found = splitSharedLink("https://example.com/a and https://example.com/b");
  assert.equal(found?.url, "https://example.com/a");
  assert.equal(found?.note, "and https://example.com/b");
});
