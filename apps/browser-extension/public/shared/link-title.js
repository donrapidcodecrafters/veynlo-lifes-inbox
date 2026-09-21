/**
 * What to call a page this extension is saving.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why the browser's own title is not always enough
 * ---------------------------------------------------------------------------------------------------
 * Usually it is, and that is this extension's advantage over anything fetching the page from a server: the
 * browser has already run the page's JavaScript, so `document.title` for a TikTok video is the video's
 * title and for an Instagram profile is the profile.
 *
 * Measured in a real browser, though, Google Maps titles its own place pages with the literal words
 * "Google Maps" — the Statue of Liberty page, Blue Bottle Coffee, all of them. Saving a place from the
 * desktop browser therefore filed it as "Google Maps", exactly as sharing one from a phone filed it as
 * "Google Maps" before the mobile fix. The place name is in the URL.
 *
 * ---------------------------------------------------------------------------------------------------
 * This rule exists twice, on purpose, and is kept honest by a shared fixture
 * ---------------------------------------------------------------------------------------------------
 * The server has the same rule in TypeScript (link-preview.service.ts's `placeFromMapUrl`). This
 * extension has no bundler and cannot import it, so the logic is duplicated — and two copies of one rule
 * is how the provider-label map ended up wrong in six places at once.
 *
 * So neither copy owns the truth. `packages/core/src/link/map-url-cases.json` does, and both test suites
 * read it. A case added there has to be satisfied on both sides or the build goes red.
 */

/**
 * The place a maps link points at, taken from the URL itself.
 *
 * Only the name. Not the coordinates, which are also in that URL — a saved link should record what the
 * place is, not build a record of where someone has been looking.
 */
export function placeFromMapUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isCoordinatePair = (value) => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(value.trim());

  if (host.endsWith("google.com") || host.endsWith("google.co.uk") || host === "maps.google.com") {
    const inPath = url.pathname.match(/\/maps\/place\/([^/@]+)/);
    if (inPath && inPath[1]) {
      const name = decodeURIComponent(inPath[1].replace(/\+/g, " ")).trim();
      if (name) return name;
    }
    const query = url.searchParams.get("q");
    if (query && !isCoordinatePair(query)) return query.trim();
  }

  if (host === "maps.apple.com") {
    const query = url.searchParams.get("q") || url.searchParams.get("address");
    // Apple Maps uses `q` for both a place name and a raw coordinate pair; a coordinate is not a name.
    if (query && !isCoordinatePair(query)) return query.trim();
  }

  return null;
}

/**
 * The title to save a page under: the place a maps URL names, otherwise whatever the browser called it.
 *
 * The URL is the last resort rather than the second, because a page with no title at all is rare and a
 * URL is at least unambiguous.
 */
export function titleForPage(url, documentTitle) {
  return placeFromMapUrl(url) || (documentTitle || "").trim() || url;
}
