import { describe, expect, it } from "vitest";
import { decodeEntities, extractOpenGraph, oembedEndpointFor, placeFromMapUrl } from "./link-preview.service";

/**
 * Turning a shared link into something a household recognises a week later.
 *
 * Measured against the live sites before any of this existed: of the ten share-link targets in Appendix A,
 * ONE produced a title that named the thing shared rather than the site it came from. A saved TikTok read
 * "TikTok - Make Your Day". A saved Google Maps place read "Google Maps", with a body consisting of the
 * sentence "When you have eliminated the JavaScript, whatever remains must be an empty page".
 *
 * The failure that matters here is silent: a capture that succeeds, files a row, and tells nobody
 * anything. Nothing errors, nothing is missing, and the list is useless.
 */

describe("finding a site's oEmbed endpoint", () => {
  it("knows the providers that were actually tested against", () => {
    // Each of these was confirmed against the live endpoint, not taken from documentation.
    expect(oembedEndpointFor("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toContain("youtube.com/oembed");
    expect(oembedEndpointFor("https://www.tiktok.com/@tiktok/video/123")).toContain("tiktok.com/oembed");
    expect(oembedEndpointFor("https://www.pinterest.com/pin/123/")).toContain("pinterest.com/oembed");
    expect(oembedEndpointFor("https://www.reddit.com/r/x/comments/abc/title/")).toContain("reddit.com/oembed");
    expect(oembedEndpointFor("https://open.spotify.com/track/abc")).toContain("spotify.com/oembed");
  });

  it("covers the short domains a share button actually produces", () => {
    // What gets shared from a phone is almost never the canonical URL — it is youtu.be, pin.it, vm.tiktok.
    // Matching only the long form would leave the common case falling through to the page.
    expect(oembedEndpointFor("https://youtu.be/jNQXAC9IVRw")).toContain("youtube.com/oembed");
    expect(oembedEndpointFor("https://pin.it/abc123")).toContain("pinterest.com/oembed");
    expect(oembedEndpointFor("https://vm.tiktok.com/ZMabc/")).toContain("tiktok.com/oembed");
    expect(oembedEndpointFor("https://m.youtube.com/watch?v=x")).toContain("youtube.com/oembed");
  });

  it("puts the whole shared URL in the query, escaped", () => {
    const endpoint = oembedEndpointFor("https://www.youtube.com/watch?v=abc&t=30s");
    expect(endpoint).toContain(encodeURIComponent("https://www.youtube.com/watch?v=abc&t=30s"));
    // Unescaped, the "&t=30s" would become a second parameter of the oEmbed request rather than part of
    // the URL being asked about.
    expect(endpoint).not.toContain("watch?v=abc&t=30s&");
  });

  it("says no for a site that publishes none", () => {
    expect(oembedEndpointFor("https://example.com/article")).toBeNull();
    expect(oembedEndpointFor("https://www.yelp.com/biz/x")).toBeNull();
    expect(oembedEndpointFor("not a url")).toBeNull();
  });

  it("is not fooled by a hostname that merely ends with a provider's name", () => {
    // "youtube.com.evil.example" ends with neither an exact host match nor anything this should call.
    expect(oembedEndpointFor("https://youtube.com.evil.example/x")).toBeNull();
    expect(oembedEndpointFor("https://notyoutube.com/watch?v=x")).toBeNull();
  });
});

describe("reading Open Graph tags", () => {
  it("reads a title and description", () => {
    const og = extractOpenGraph(
      '<html><head><meta property="og:title" content="Me at the zoo"><meta property="og:description" content="The first video">' +
        '<meta property="og:site_name" content="YouTube"><meta property="og:type" content="video.other"></head></html>',
    );
    expect(og).toEqual({ title: "Me at the zoo", description: "The first video", siteName: "YouTube", type: "video.other" });
  });

  it("copes with the attributes in the other order", () => {
    // Real pages put content= before property= often enough that assuming one order loses them silently.
    const og = extractOpenGraph('<meta content="Basement Water Sensor" property="og:title">');
    expect(og.title).toBe("Basement Water Sensor");
  });

  it("falls back to the twitter: equivalents", () => {
    const og = extractOpenGraph('<meta name="twitter:title" content="A thing"><meta name="twitter:description" content="About it">');
    expect(og.title).toBe("A thing");
    expect(og.description).toBe("About it");
  });

  it("decodes the entities that actually turn up in live titles", () => {
    // Instagram's og:title arrives exactly like this.
    const og = extractOpenGraph('<meta property="og:title" content="Instagram (&#064;instagram) &#x2022; Instagram photos">');
    expect(og.title).toBe("Instagram (@instagram) • Instagram photos");
  });

  it("returns nulls rather than empty strings when a page has no tags", () => {
    expect(extractOpenGraph("<html><body>nothing here</body></html>")).toEqual({
      title: null,
      description: null,
      siteName: null,
      type: null,
    });
    expect(extractOpenGraph("")).toEqual({ title: null, description: null, siteName: null, type: null });
  });

  it("ignores a tag whose content is blank", () => {
    // An empty og:title must not beat the page's real <title> — it carries no information at all.
    expect(extractOpenGraph('<meta property="og:title" content="">').title).toBeNull();
    expect(extractOpenGraph('<meta property="og:title" content="   ">').title).toBeNull();
  });
});

describe("decoding entities", () => {
  it("handles decimal, hex and named forms", () => {
    expect(decodeEntities("&#064;")).toBe("@");
    expect(decodeEntities("&#x2022;")).toBe("•");
    expect(decodeEntities("Ben &amp; Jerry&apos;s")).toBe("Ben & Jerry's");
    expect(decodeEntities("&lt;b&gt;")).toBe("<b>");
  });

  it("decodes &amp; last, so an escaped entity is not decoded twice", () => {
    // "&amp;#064;" is the literal text "&#064;", not an "@". Decoding &amp; first would turn it into one.
    expect(decodeEntities("&amp;#064;")).toBe("&#064;");
  });

  it("leaves ordinary text alone", () => {
    expect(decodeEntities("Statue of Liberty")).toBe("Statue of Liberty");
  });
});

describe("the place a maps link points at", () => {
  it("reads a Google Maps place out of the path", () => {
    // Google Maps serves an empty shell to anything that is not a browser — its og:title is the literal
    // words "Google Maps" — so the name in the path is the only thing that survives.
    expect(placeFromMapUrl("https://www.google.com/maps/place/Statue+of+Liberty")).toBe("Statue of Liberty");
    expect(placeFromMapUrl("https://www.google.com/maps/place/Blue+Bottle+Coffee/@37.7,-122.4,17z")).toBe("Blue Bottle Coffee");
  });

  it("decodes an escaped place name", () => {
    expect(placeFromMapUrl("https://www.google.com/maps/place/Caf%C3%A9+Grumpy")).toBe("Café Grumpy");
  });

  it("reads an Apple Maps query", () => {
    expect(placeFromMapUrl("https://maps.apple.com/?q=Statue+of+Liberty")).toBe("Statue of Liberty");
    expect(placeFromMapUrl("https://maps.apple.com/?address=1+Infinite+Loop")).toBe("1 Infinite Loop");
  });

  it("refuses to treat a coordinate pair as a place name", () => {
    // Both maps apps put a raw lat/long in `q`. "40.689,-74.044" is not a name, and saving it as the title
    // of a place would be worse than having no title — it also records where somebody was looking.
    expect(placeFromMapUrl("https://maps.apple.com/?q=40.6892,-74.0445")).toBeNull();
    expect(placeFromMapUrl("https://www.google.com/maps?q=40.6892,-74.0445")).toBeNull();
  });

  it("returns null for a maps link that names nothing", () => {
    expect(placeFromMapUrl("https://www.google.com/maps")).toBeNull();
    expect(placeFromMapUrl("https://maps.apple.com/")).toBeNull();
  });

  it("returns null for a URL that is not a maps link at all", () => {
    expect(placeFromMapUrl("https://example.com/maps/place/Nowhere")).toBeNull();
    expect(placeFromMapUrl("not a url")).toBeNull();
  });
});
