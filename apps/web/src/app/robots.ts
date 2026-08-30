import type { MetadataRoute } from "next";

/**
 * This entire app is a signed-in product, not public content — there's nothing here worth indexing.
 * `/shared/*` gets called out explicitly (not just covered by the blanket disallow) because those are
 * long-lived bearer-token URLs: a well-behaved crawler that ever discovers one via a referrer/backlink
 * must never index or re-crawl it. See also the noindex meta on shared/[token]'s own layout, which is the
 * defense that still holds even against a crawler that ignores this file entirely.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: ["/", "/shared/"] }],
  };
}
