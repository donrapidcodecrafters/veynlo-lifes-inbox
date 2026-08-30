import { describe, expect, it } from "vitest";
import { stripHtml, decodeHtmlEntities } from "./html-strip.util";

describe("stripHtml", () => {
  it("strips tags and collapses whitespace", () => {
    expect(stripHtml("<div>Hello <strong>world</strong></div>")).toBe("Hello world");
  });

  it("removes script content, not just the tags around it — a bare tag-strip would leak this straight into what the AI pipeline reads", () => {
    expect(stripHtml("<p>Total: $42</p><script>trackConversion({amount: 42});</script>")).toBe("Total: $42");
  });

  it("removes style content the same way", () => {
    expect(stripHtml("<style>.receipt { color: red; font-size: 14px; }</style><p>Receipt</p>")).toBe("Receipt");
  });

  it("decodes common entities that show up in real email/web markup", () => {
    expect(stripHtml('<p>Terms &amp; Conditions &mdash; &quot;Fine print&quot;</p>')).toBe('Terms & Conditions &mdash; "Fine print"');
  });
});

describe("decodeHtmlEntities", () => {
  it("decodes the handful of entities actually handled", () => {
    expect(decodeHtmlEntities("A&nbsp;B&amp;C&lt;D&gt;E&quot;F&#39;G")).toBe("A B&C<D>E\"F'G");
  });
});
