import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { SafeUrlFetcher, extractTitle, stripHtml } from "./safe-url-fetcher";

/**
 * Understanding a link somebody shared.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------------------------------
 * Ten of Appendix A's targets are share-link targets — Instagram, Facebook, TikTok, Reddit, Pinterest,
 * YouTube, Apple Maps, Google Maps, Yelp and Tripadvisor. None needs a credential or a partnership. They
 * need a shared URL to turn into something a household can recognise a week later.
 *
 * Measured against the live sites before any of this was written: **one of the ten** did. Everything else
 * came back as a login wall, an empty JavaScript shell, or a 403. A saved TikTok read "TikTok - Make Your
 * Day"; a saved Google Maps place read "Google Maps", with a body consisting of the sentence "When you
 * have eliminated the JavaScript, whatever remains must be an empty page". A person looking at that list
 * later cannot tell one saved link from another.
 *
 * The cause is not a bug. Fetching the HTML of a modern social page and reading its text is simply the
 * wrong way to ask these sites what a link is about — they render in the browser, and they gate the body
 * behind a login. There is a right way, and most of them publish it.
 *
 * ---------------------------------------------------------------------------------------------------
 * Three ways of asking, in order of how much the site is actually telling us
 * ---------------------------------------------------------------------------------------------------
 *   oEmbed        A documented endpoint a site publishes SO THAT other software can describe its links.
 *                 No key, no partnership, no scraping — it is the front door for exactly this question.
 *                 Verified working against live endpoints for YouTube, TikTok, Pinterest, Reddit posts
 *                 and Spotify.
 *
 *   Open Graph    The meta tags a page serves for link previews. They frequently survive on a page whose
 *                 visible body is an empty shell, which is precisely the case that defeats reading text.
 *                 Verified working for Instagram, Facebook, Pinterest, YouTube and Apple Maps.
 *
 *   the page      Title plus readable text, which is what this did before and remains right for an
 *                 ordinary web page — a recipe, a news article, a product listing.
 *
 * Nothing here is a scraper working around a site's wishes. oEmbed and Open Graph are both mechanisms a
 * site opts into publishing; if a site offers neither, this falls back to reading the page exactly as
 * before, and if a site refuses the request outright that refusal is passed on rather than worked around.
 *
 * ---------------------------------------------------------------------------------------------------
 * What is NOT here, and why
 * ---------------------------------------------------------------------------------------------------
 * Yelp and Tripadvisor answer 403 to this deployment regardless of route, and neither publishes an oEmbed
 * endpoint. They are left refusing rather than given a disguised user-agent: pretending to be a browser to
 * get past a block is the site being told something untrue about who is asking, and this codebase does not
 * do that. Those two targets stay honestly unavailable.
 */

/**
 * Hosts that publish an oEmbed endpoint, and how to build it.
 *
 * Every entry here was confirmed against the live endpoint rather than taken from documentation — Vimeo's
 * was in the first draft of this list and is not here now, because the endpoint answered 404 for a real
 * video URL. A provider list that has never been exercised is a list of guesses.
 */
const OEMBED_ENDPOINTS: { hosts: string[]; build: (url: string) => string }[] = [
  {
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com"],
    build: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  },
  {
    hosts: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "m.tiktok.com"],
    build: (url) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
  },
  {
    hosts: ["pinterest.com", "www.pinterest.com", "pin.it", "pinterest.co.uk", "pinterest.ca"],
    build: (url) => `https://www.pinterest.com/oembed.json?url=${encodeURIComponent(url)}`,
  },
  {
    hosts: ["reddit.com", "www.reddit.com", "old.reddit.com", "np.reddit.com"],
    build: (url) => `https://www.reddit.com/oembed?url=${encodeURIComponent(url)}`,
  },
  {
    hosts: ["open.spotify.com"],
    build: (url) => `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`,
  },
  {
    hosts: ["soundcloud.com", "www.soundcloud.com"],
    build: (url) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  },
  {
    hosts: ["flickr.com", "www.flickr.com", "flic.kr"],
    build: (url) => `https://www.flickr.com/services/oembed?format=json&url=${encodeURIComponent(url)}`,
  },
];

export function oembedEndpointFor(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const provider = OEMBED_ENDPOINTS.find((p) => p.hosts.includes(host));
  return provider ? provider.build(url.toString()) : null;
}

/**
 * Decode the handful of HTML entities that actually turn up in titles.
 *
 * Not a general-purpose decoder, and deliberately so — this text is never rendered as HTML, so the job is
 * readability rather than correctness across the full entity table. Measured on live pages: Instagram's
 * og:title arrives as "Instagram (&#064;instagram) &#x2022; Instagram photos and videos", which a person
 * should not have to read.
 */
export function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // Last, so an "&amp;#064;" cannot be double-decoded into something that was never in the source.
    .replace(/&amp;/g, "&");
}

export interface OpenGraph {
  title: string | null;
  description: string | null;
  siteName: string | null;
  type: string | null;
}

/** The Open Graph tags a page serves for link previews. */
export function extractOpenGraph(html: string): OpenGraph {
  const read = (property: string): string | null => {
    // Attribute order varies between sites, so both orders are tried rather than assuming one.
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]*?content=["']([^"']*)["']`, "i"),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?(?:property|name)=["']${property}["']`, "i"),
    ];
    for (const pattern of patterns) {
      const found = html.match(pattern)?.[1];
      if (found && found.trim()) return decodeEntities(found.trim());
    }
    return null;
  };
  return {
    title: read("og:title") ?? read("twitter:title"),
    description: read("og:description") ?? read("twitter:description"),
    siteName: read("og:site_name"),
    type: read("og:type"),
  };
}

/**
 * The place a maps link points at, taken from the URL itself.
 *
 * Google Maps serves an empty shell to anything that is not a browser — its og:title is the literal words
 * "Google Maps" — but the place name is sitting in the path of the link the user shared. Reading it there
 * costs no request and cannot be blocked.
 *
 * Only the name. Not the coordinates, which are also in that URL: a saved link should record what the
 * place is, not build a record of where someone has been looking.
 */
export function placeFromMapUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();

  if (host.endsWith("google.com") || host.endsWith("google.co.uk") || host === "maps.google.com") {
    const inPath = url.pathname.match(/\/maps\/place\/([^/@]+)/);
    if (inPath?.[1]) {
      const name = decodeURIComponent(inPath[1].replace(/\+/g, " ")).trim();
      if (name) return name;
    }
    const query = url.searchParams.get("q");
    if (query && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(query.trim())) return query.trim();
  }

  if (host === "maps.apple.com") {
    const query = url.searchParams.get("q") ?? url.searchParams.get("address");
    // Apple Maps uses `q` for both a place name and a raw coordinate pair; a coordinate is not a name.
    if (query && !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(query.trim())) return query.trim();
  }

  return null;
}

export interface LinkDescription {
  title: string;
  text: string;
  finalUrl: string;
  /** Which route produced the title — recorded so a later quality question has an answer. */
  via: "oembed" | "open-graph" | "map-url" | "page";
}

/**
 * Titles that name the site rather than the thing, and therefore tell a household nothing.
 *
 * ---------------------------------------------------------------------------------------------------
 * The clever version of this was wrong
 * ---------------------------------------------------------------------------------------------------
 * The first attempt stripped the brand out of the title and flagged whatever was left if it was short —
 * "TikTok - Make Your Day" leaves "Make Your Day", thirteen characters, so it was flagged.
 *
 * But "Me at the zoo - YouTube" leaves "Me at the zoo". Also thirteen characters. One is a tagline and one
 * is the actual title of the thing somebody saved, and no length threshold can tell them apart. The
 * heuristic would have silently thrown away good titles, which is the same failure it exists to prevent.
 *
 * So: two rules, both of which can be checked rather than guessed at.
 */

/**
 * The first rule, and the general one: a page whose og:title is exactly its og:site_name has told us only
 * which website we are on. Google Maps does this on every place page.
 */

/**
 * The second rule, for pages that publish no site name to compare against. Small, explicit, and every
 * entry MEASURED against the live site rather than imagined — this is a list of titles that were actually
 * observed standing in for real content.
 */
const TITLES_THAT_NAME_ONLY_THE_SITE = new Set([
  "facebook",
  "reddit",
  "google maps",
  "tiktok",
  "tiktok - make your day",
  "pinterest",
  "youtube",
  "instagram",
  "x",
  "twitter",
]);

function namesOnlyTheSite(title: string, siteName: string | null): boolean {
  const t = title.trim().toLowerCase();
  if (!t) return true;
  if (siteName && t === siteName.trim().toLowerCase()) return true;
  return TITLES_THAT_NAME_ONLY_THE_SITE.has(t);
}

@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);

  constructor(@Inject(SafeUrlFetcher) private readonly urlFetcher: SafeUrlFetcher) {}

  /** oEmbed, if this host publishes one and answers. Null rather than throwing — this is one of three tries. */
  private async askOembed(rawUrl: string): Promise<{ title: string; author: string | null } | null> {
    const endpoint = oembedEndpointFor(rawUrl);
    if (!endpoint) return null;
    try {
      const { body } = await this.urlFetcher.fetchTrustedBytes(endpoint, {
        headers: { accept: "application/json" },
        // A link preview is made while somebody waits. A slow provider must not hold up the capture, which
        // still succeeds via the page itself.
        timeoutMs: 6000,
        maxBytes: 256 * 1024,
      });
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object") return null;
      const record = parsed as Record<string, unknown>;
      const title = typeof record.title === "string" ? decodeEntities(record.title).trim() : "";
      if (!title) return null;
      const author = typeof record.author_name === "string" && record.author_name.trim() ? decodeEntities(record.author_name).trim() : null;
      return { title, author };
    } catch (err) {
      // Entirely expected for a URL the provider does not recognise — a subreddit listing rather than a
      // post, say, answers 400. Logged at debug level because it is a normal outcome, not a fault.
      this.logger.debug(`oembed declined for ${new URL(rawUrl).hostname}: ${(err as Error)?.name ?? "error"}`);
      return null;
    }
  }

  /**
   * Describe a shared link as well as the site is willing to be described.
   *
   * Never throws for a site that simply has no preview to offer — it falls through to the page. It DOES
   * throw when the page itself cannot be fetched, because that is a real failure the user needs told
   * about, and swallowing it would file an empty capture that looks like it worked.
   */
  async describe(rawUrl: string): Promise<LinkDescription> {
    // Cheapest first, and unblockable: a maps link already carries its place name.
    const place = placeFromMapUrl(rawUrl);

    const oembed = await this.askOembed(rawUrl);

    // The page is fetched ONCE, and title, readable text and Open Graph all come out of that one body.
    // An earlier draft called `fetchReadableText` and then fetched the same URL again for its raw HTML,
    // because the readable version has already had its tags stripped — two requests to somebody's server
    // for one shared link, which is both slower for the user and worse manners.
    const raw = await this.urlFetcher.fetchTrustedBytes(rawUrl);
    if (!raw.contentType.includes("text/html") && !raw.contentType.includes("text/plain")) {
      throw new BadRequestException({ code: "UNSUPPORTED_CONTENT_TYPE", message: "That URL isn't a readable web page." });
    }
    const page = {
      title: extractTitle(raw.body) ?? new URL(raw.finalUrl).hostname,
      text: stripHtml(raw.body).slice(0, 20_000),
      finalUrl: raw.finalUrl,
    };
    const og: OpenGraph = extractOpenGraph(raw.body);

    if (place) {
      return {
        title: place,
        text: [place, page.text].filter(Boolean).join("\n\n").slice(0, 20_000),
        finalUrl: page.finalUrl,
        via: "map-url",
      };
    }

    if (oembed) {
      return {
        title: oembed.author ? `${oembed.title} — ${oembed.author}` : oembed.title,
        text: [oembed.title, oembed.author, page.text].filter(Boolean).join("\n\n").slice(0, 20_000),
        finalUrl: page.finalUrl,
        via: "oembed",
      };
    }

    if (og.title && !namesOnlyTheSite(og.title, og.siteName)) {
      return {
        title: og.title,
        text: [og.title, og.description, page.text].filter(Boolean).join("\n\n").slice(0, 20_000),
        finalUrl: page.finalUrl,
        via: "open-graph",
      };
    }

    // An og:description can be worth keeping even when its title is only the site's name — Facebook's
    // page title is "Facebook" while its description names the page and its follower count.
    if (og.description) {
      return {
        title: page.title,
        text: [og.description, page.text].filter(Boolean).join("\n\n").slice(0, 20_000),
        finalUrl: page.finalUrl,
        via: "open-graph",
      };
    }

    return { title: page.title, text: page.text, finalUrl: page.finalUrl, via: "page" };
  }
}
