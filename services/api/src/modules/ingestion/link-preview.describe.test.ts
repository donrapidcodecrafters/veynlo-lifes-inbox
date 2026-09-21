import { describe, expect, it } from "vitest";
import { LinkPreviewService } from "./link-preview.service";
import type { SafeUrlFetcher } from "./safe-url-fetcher";

/**
 * Which of the three sources wins, and what ends up in the capture.
 *
 * `link-preview.test.ts` proves the parsers. This proves the ORDER — the part that decides whether a
 * shared TikTok is filed as "TikTok - Make Your Day" or as what it actually is.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why a fake fetcher rather than a local server
 * ---------------------------------------------------------------------------------------------------
 * `SafeUrlFetcher` resolves every hostname and refuses private addresses through a module-level function,
 * not a method, so unlike CanvasService and HomeAssistantService there is no seam to override and a test
 * server on 127.0.0.1 cannot be reached through it. That guard is right and is not being given a hole for
 * a test's convenience — it has its own tests in `safe-url-fetcher.test.ts`.
 *
 * What is left to test here is the decision, and the decision is what a fake fetcher exercises exactly:
 * given this oEmbed answer, this HTML and this URL, which description comes out.
 */

/** Serves whatever each test sets up, and records every URL it was asked for. */
function fakeFetcher(routes: Record<string, { body: string; contentType?: string } | Error>) {
  const asked: string[] = [];
  const fetcher = {
    asked,
    async fetchTrustedBytes(url: string) {
      asked.push(url);
      const route = routes[url];
      if (!route) throw new Error(`nothing serving ${url}`);
      if (route instanceof Error) throw route;
      return { body: route.body, finalUrl: url, contentType: route.contentType ?? "text/html" };
    },
    async fetchReadableText() {
      throw new Error("describe() must fetch the page ONCE, through fetchTrustedBytes");
    },
  };
  return fetcher as unknown as SafeUrlFetcher & { asked: string[] };
}

const page = (inner: string) => `<html><head><title>Page title</title>${inner}</head><body>${"filler text. ".repeat(20)}</body></html>`;

describe("describing a shared link", () => {
  it("prefers oEmbed, because it is the site answering the question directly", async () => {
    const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
    const fetcher = fakeFetcher({
      [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`]: {
        body: JSON.stringify({ title: "Me at the zoo", author_name: "jawed" }),
      },
      [url]: { body: page('<meta property="og:title" content="Me at the zoo - YouTube">') },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.via).toBe("oembed");
    expect(result.title).toBe("Me at the zoo — jawed");
    // The author belongs in the title: a list of six saved videos all called "Highlights" is not a list.
    expect(result.text).toContain("jawed");
  });

  it("falls back to Open Graph when the site publishes no oEmbed", async () => {
    const url = "https://www.instagram.com/instagram/";
    const fetcher = fakeFetcher({
      [url]: {
        body: page(
          '<meta property="og:title" content="Instagram (&#064;instagram)">' +
            '<meta property="og:description" content="687M Followers, 299 Following">',
        ),
      },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.via).toBe("open-graph");
    expect(result.title).toBe("Instagram (@instagram)");
    expect(result.text).toContain("687M Followers");
  });

  it("reads a maps link's place before making any request for a preview", async () => {
    const url = "https://www.google.com/maps/place/Statue+of+Liberty";
    const fetcher = fakeFetcher({ [url]: { body: page('<meta property="og:title" content="Google Maps">') } });
    const service = new LinkPreviewService(fetcher);
    const result = await service.describe(url);
    expect(result.via).toBe("map-url");
    expect(result.title).toBe("Statue of Liberty");
    // Google's own og:title for a place page is the literal words "Google Maps" — winning over it is the
    // entire point, and taking it would file every saved place under the same name.
    expect(result.title).not.toBe("Google Maps");
  });

  it("refuses an og:title that only names the site", async () => {
    // Facebook serves og:title "Facebook" on a page whose description names the actual page. Taking that
    // title would file every saved Facebook link identically.
    const url = "https://www.facebook.com/facebook";
    const fetcher = fakeFetcher({
      [url]: {
        body: page('<meta property="og:title" content="Facebook"><meta property="og:description" content="154,763,634 followers">'),
      },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.title).not.toBe("Facebook");
    // But its description is real and is kept, because it is the only thing on that page that says what
    // the link was.
    expect(result.text).toContain("154,763,634 followers");
  });

  it("rejects an og:title that is exactly the site's own name", async () => {
    // The general rule, and the one that catches sites nobody has thought to add to a list. Deliberately
    // NOT a maps URL: a maps link is answered from its path before Open Graph is ever consulted, so a test
    // using one leaves this rule unexercised — which is exactly what falsification found, with the break
    // that removes this rule staying green.
    const url = "https://shop.example.com/products/kettle";
    const fetcher = fakeFetcher({
      [url]: {
        body: page(
          '<meta property="og:title" content="Example Shop"><meta property="og:site_name" content="Example Shop">' +
            '<meta property="og:description" content="A 1.7 litre stainless steel kettle">',
        ),
      },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.title).not.toBe("Example Shop");
    // The description still names the thing, so it is kept.
    expect(result.text).toContain("1.7 litre stainless steel kettle");
  });

  it("keeps an og:title that merely SHARES words with the site name", async () => {
    // The rule is equality, not containment. "Example Shop — Kettles" is a real title on Example Shop.
    const url = "https://shop.example.com/c/kettles";
    const fetcher = fakeFetcher({
      [url]: {
        body: page('<meta property="og:title" content="Example Shop — Kettles"><meta property="og:site_name" content="Example Shop">'),
      },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.title).toBe("Example Shop — Kettles");
  });

  it("recognises a site-name title even with a tagline attached", async () => {
    const url = "https://www.tiktok.com/@tiktok";
    const fetcher = fakeFetcher({
      [`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`]: new Error("400"),
      [url]: { body: page('<meta property="og:title" content="TikTok - Make Your Day">') },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.title).not.toBe("TikTok - Make Your Day");
  });

  it("keeps an ordinary page working exactly as before", async () => {
    // The overwhelmingly common case is not a social link at all — it is a recipe, an article, a product.
    // None of this may make those worse.
    const url = "https://example.com/recipes/sourdough";
    const fetcher = fakeFetcher({ [url]: { body: "<html><head><title>Overnight Sourdough</title></head><body>Mix the flour and water.</body></html>" } });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.via).toBe("page");
    expect(result.title).toBe("Overnight Sourdough");
    expect(result.text).toContain("Mix the flour and water");
  });

  it("does not let a broken oEmbed provider lose the capture", async () => {
    // A provider that is down, rate-limiting, or simply does not recognise this URL is an ordinary event.
    // The page still has to be filed.
    const url = "https://www.reddit.com/r/homeassistant/";
    const fetcher = fakeFetcher({
      [`https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`]: new Error("oembed exploded"),
      [url]: { body: "<html><head><title>r/homeassistant</title></head><body>Home Assistant community.</body></html>" },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.title).toBe("r/homeassistant");
  });

  it("does not let malformed oEmbed JSON lose the capture", async () => {
    const url = "https://www.youtube.com/watch?v=abc";
    const fetcher = fakeFetcher({
      [`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`]: { body: "not json at all" },
      [url]: { body: "<html><head><title>A video</title></head><body>Body text here.</body></html>" },
    });
    const result = await new LinkPreviewService(fetcher).describe(url);
    expect(result.title).toBe("A video");
  });

  it("fetches the page exactly once", async () => {
    // An earlier draft asked for the readable text and then asked for the same URL again to get its raw
    // HTML for the Open Graph tags — two requests to somebody's server for one shared link.
    const url = "https://example.com/article";
    const fetcher = fakeFetcher({ [url]: { body: page('<meta property="og:title" content="A real headline">') } });
    await new LinkPreviewService(fetcher).describe(url);
    expect(fetcher.asked.filter((u) => u === url)).toHaveLength(1);
  });

  it("refuses something that is not a readable page", async () => {
    // A shared link to a 40MB video file is not a capture, and must not be filed as one.
    const url = "https://example.com/clip.mp4";
    const fetcher = fakeFetcher({ [url]: { body: "binary-ish", contentType: "video/mp4" } });
    await expect(new LinkPreviewService(fetcher).describe(url)).rejects.toThrow(/readable web page/i);
  });

  it("passes on a page that genuinely cannot be fetched", async () => {
    // Swallowing this would file an empty capture that looks like it worked — worse than an error,
    // because nobody goes back to look at it.
    const url = "https://example.com/gone";
    const fetcher = fakeFetcher({ [url]: new Error("That page returned an error (404).") });
    await expect(new LinkPreviewService(fetcher).describe(url)).rejects.toThrow(/404/);
  });
});
