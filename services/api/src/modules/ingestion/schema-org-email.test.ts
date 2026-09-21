import { describe, expect, it } from "vitest";
import { extractSchemaOrgFromHtml, hasUsableMarkup } from "./schema-org-email";

/**
 * The structured data retailers already send, read instead of re-derived.
 *
 * Two classes of test here, and the second matters more than the first:
 *
 *   1. Real markup shapes produce the right values. The fixtures below are the shapes Gmail's own
 *      documentation and real order confirmations use — `@graph` wrappers, `@type` arrays, money as a
 *      string, an `Offer` wrapping the product.
 *
 *   2. Hostile markup does not become a problem. Anyone who can send an email can put anything in that
 *      script tag: a prototype-pollution key, a 200 MB array, a thousand nested objects, or plain garbage.
 *      Every one of those has to cost a bounded amount of work and yield nothing, and — critically — must
 *      not stop the REST of the message being read.
 */

const wrap = (json: string) => `<html><body><p>Thanks for your order</p><script type="application/ld+json">${json}</script></body></html>`;

describe("extractSchemaOrgFromHtml — real markup", () => {
  it("reads an order with merchant, number, total and line items", () => {
    const html = wrap(
      JSON.stringify({
        "@context": "http://schema.org",
        "@type": "Order",
        merchant: { "@type": "Organization", name: "Example Outfitters" },
        orderNumber: "AB-99120",
        orderDate: "2026-09-18T14:02:11Z",
        orderStatus: "http://schema.org/OrderProcessing",
        priceSpecification: { "@type": "PriceSpecification", price: "129.99", priceCurrency: "USD" },
        acceptedOffer: [
          {
            "@type": "Offer",
            itemOffered: { "@type": "Product", name: "Trail Jacket" },
            price: "99.99",
            priceCurrency: "USD",
            eligibleQuantity: { "@type": "QuantitativeValue", value: 1 },
          },
          {
            "@type": "Offer",
            itemOffered: { "@type": "Product", name: "Wool Socks" },
            price: "30.00",
            priceCurrency: "USD",
            eligibleQuantity: { "@type": "QuantitativeValue", value: 2 },
          },
        ],
      }),
    );

    const found = extractSchemaOrgFromHtml(html);
    expect(found.orders).toHaveLength(1);
    const order = found.orders[0]!;
    expect(order.orderNumber).toBe("AB-99120");
    expect(order.merchantName).toBe("Example Outfitters");
    expect(order.orderDate).toBe("2026-09-18");
    expect(order.totalMinorUnits).toBe(12_999);
    expect(order.currency).toBe("USD");
    expect(order.orderStatus).toBe("OrderProcessing");
    expect(order.lineItems).toHaveLength(2);
    expect(order.lineItems[0]).toEqual({ name: "Trail Jacket", quantity: 1, priceMinorUnits: 9_999, currency: "USD" });
    expect(order.lineItems[1]).toEqual({ name: "Wool Socks", quantity: 2, priceMinorUnits: 3_000, currency: "USD" });
    expect(hasUsableMarkup(found)).toBe(true);
  });

  it("reads a parcel delivery, including the order it belongs to", () => {
    const html = wrap(
      JSON.stringify({
        "@context": "http://schema.org",
        "@type": "ParcelDelivery",
        trackingNumber: "1Z999AA10123456784",
        carrier: { "@type": "Organization", name: "UPS" },
        expectedArrivalFrom: "2026-09-22T00:00:00Z",
        expectedArrivalUntil: "2026-09-24",
        deliveryStatus: "http://schema.org/InTransit",
        trackingUrl: "https://example.test/track/1Z999AA10123456784",
        partOfOrder: {
          "@type": "Order",
          orderNumber: "AB-99120",
          merchant: { "@type": "Organization", name: "Example Outfitters" },
        },
      }),
    );

    const found = extractSchemaOrgFromHtml(html);
    expect(found.parcels).toHaveLength(1);
    expect(found.parcels[0]).toEqual({
      trackingNumber: "1Z999AA10123456784",
      carrier: "UPS",
      orderNumber: "AB-99120",
      merchantName: "Example Outfitters",
      expectedArrivalFrom: "2026-09-22",
      expectedArrivalUntil: "2026-09-24",
      deliveryStatus: "InTransit",
      trackingUrl: "https://example.test/track/1Z999AA10123456784",
    });
  });

  it("handles the shapes real markup actually uses: @graph, type arrays, bare-string orgs, multiple blocks", () => {
    const html = `<html><body>
      <script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@graph": [{ "@type": ["Order", "Thing"], orderNumber: "G-1", seller: "Graph Store" }],
      })}</script>
      <script type='application/ld+json'>${JSON.stringify([
        { "@type": "ParcelDelivery", trackingNumber: "T-2", provider: "FedEx" },
      ])}</script>
    </body></html>`;

    const found = extractSchemaOrgFromHtml(html);
    expect(found.blocksSeen).toBe(2);
    expect(found.blocksRejected).toBe(0);
    expect(found.orders[0]?.orderNumber).toBe("G-1");
    // A bare string is a legal Organization value and must not be dropped.
    expect(found.orders[0]?.merchantName).toBe("Graph Store");
    expect(found.parcels[0]?.trackingNumber).toBe("T-2");
    expect(found.parcels[0]?.carrier).toBe("FedEx");
  });

  it("returns nothing for an email with no markup at all", () => {
    const found = extractSchemaOrgFromHtml("<html><body><p>Just a newsletter</p></body></html>");
    expect(found).toEqual({ orders: [], parcels: [], reservations: [], blocksSeen: 0, blocksRejected: 0 });
    expect(hasUsableMarkup(found)).toBe(false);
  });

  it("ignores a declared entity that states nothing usable", () => {
    // An empty shell is not a finding. Returning it would hand the caller a record that looks real.
    const found = extractSchemaOrgFromHtml(wrap(JSON.stringify({ "@type": "Order", "@context": "https://schema.org" })));
    expect(found.orders).toHaveLength(0);
    expect(hasUsableMarkup(found)).toBe(false);
  });
});

describe("extractSchemaOrgFromHtml — values are never invented", () => {
  it("scales money exactly, including the amounts a float multiply gets wrong", () => {
    // Chosen because they are the ones that actually break. 129.99 * 100 is exactly 12999 in JS, so an
    // order total of 129.99 proves nothing about the scaler — the first version of this suite used it and
    // a deliberate truncation bug sailed straight through. These two do not survive multiplication:
    //   1.15 * 100 = 114.99999999999999   -> truncating gives 114
    //   8.20 * 100 = 819.9999999999999    -> truncating gives 819
    const cases: Array<[string, number]> = [
      ["1.15", 115],
      ["8.20", 820],
      ["129.99", 12_999],
      ["0.01", 1],
      ["1000000.00", 100_000_000],
    ];

    for (const [price, expected] of cases) {
      const found = extractSchemaOrgFromHtml(wrap(JSON.stringify({ "@type": "Order", orderNumber: "M", price })));
      expect(found.orders[0]?.totalMinorUnits, `price "${price}" scaled wrong`).toBe(expected);
    }
  });


  it("drops a price with sub-cent precision rather than rounding it", () => {
    const found = extractSchemaOrgFromHtml(wrap(JSON.stringify({ "@type": "Order", orderNumber: "X-1", price: "10.005" })));
    expect(found.orders[0]?.orderNumber).toBe("X-1");
    // Rounding would state a number the sender did not.
    expect(found.orders[0]?.totalMinorUnits).toBeNull();
  });

  it("drops an impossible date rather than repairing it", () => {
    const found = extractSchemaOrgFromHtml(wrap(JSON.stringify({ "@type": "Order", orderNumber: "X-2", orderDate: "2026-02-31" })));
    expect(found.orders[0]?.orderDate).toBeNull();
  });

  it("drops a non-ISO date rather than guessing its format", () => {
    // 03/04/2026 is 3 April or 4 March depending who sent it. Neither is knowable here.
    const found = extractSchemaOrgFromHtml(wrap(JSON.stringify({ "@type": "Order", orderNumber: "X-3", orderDate: "03/04/2026" })));
    expect(found.orders[0]?.orderDate).toBeNull();
  });

  it("drops a currency that is not a three-letter code", () => {
    const found = extractSchemaOrgFromHtml(
      wrap(JSON.stringify({ "@type": "Order", orderNumber: "X-4", price: "10.00", priceCurrency: "dollars" })),
    );
    expect(found.orders[0]?.totalMinorUnits).toBe(1_000);
    expect(found.orders[0]?.currency).toBeNull();
  });
});

describe("extractSchemaOrgFromHtml — hostile input", () => {
  it("drops a __proto__ key instead of walking into it", () => {
    // The first version of this test asserted that Object.prototype was not polluted, and passed with the
    // guard REMOVED — because `JSON.parse` defines `__proto__` as an ordinary own property rather than
    // setting a prototype, so it never pollutes on its own. The assertion was decorative.
    //
    // What the guard actually changes is observable: without it, `__proto__` is an own enumerable key, so
    // the walker descends into it and whatever a sender hid there becomes a real finding. With it, that
    // subtree is gone before anything walks it.
    const payload =
      '{"@type":"Order","orderNumber":"P-1","__proto__":{"@type":"ParcelDelivery","trackingNumber":"GHOST-PARCEL"}}';
    const found = extractSchemaOrgFromHtml(wrap(payload));

    expect(found.orders[0]?.orderNumber).toBe("P-1");
    // A parcel nobody legitimately declared must not appear.
    expect(found.parcels).toHaveLength(0);
    expect(JSON.stringify(found)).not.toContain("GHOST-PARCEL");

    // And the original property still holds, as a plain regression guard on JSON.parse's semantics.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("skips a malformed block without losing a good one in the same message", () => {
    const html = `<html><body>
      <script type="application/ld+json">{ this is not json at all </script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "Order", orderNumber: "GOOD-1" })}</script>
    </body></html>`;

    const found = extractSchemaOrgFromHtml(html);
    expect(found.blocksSeen).toBe(2);
    expect(found.blocksRejected).toBe(1);
    // One bad tag in a marketing footer must not cost the message its real markup.
    expect(found.orders[0]?.orderNumber).toBe("GOOD-1");
  });

  it("refuses an oversized block instead of parsing it", () => {
    const huge = JSON.stringify({ "@type": "Order", orderNumber: "BIG", note: "x".repeat(300 * 1024) });
    const found = extractSchemaOrgFromHtml(wrap(huge));
    expect(found.blocksSeen).toBe(1);
    expect(found.blocksRejected).toBe(1);
    expect(found.orders).toHaveLength(0);
  });

  it("survives deeply nested markup without overflowing the stack", () => {
    // Built as a STRING, not via JSON.stringify. The first version of this test constructed a 5,000-deep
    // object and stringified it, which overflowed the stack inside the test fixture before the parser was
    // ever called — the test failed while proving nothing about the code under test.
    const depth = 5_000;
    const payload = `${"{\"child\":".repeat(depth)}{"@type":"Order","orderNumber":"DEEP"}${"}".repeat(depth)}`;

    // The contract is "never throws", whether the overflow happens in JSON.parse or in the walk.
    const found = extractSchemaOrgFromHtml(wrap(payload));
    expect(found.blocksSeen).toBe(1);
    // Either JSON.parse refused it (rejected) or the depth bound stopped the walk. Both are correct; what
    // must never happen is an exception reaching the ingest.
    expect(found.orders).toHaveLength(0);
  });

  it("still reads markup nested a realistic few levels deep", () => {
    // The depth bound must not be so tight that ordinary nesting is missed — a parcel inside a @graph
    // inside an array is three levels before the entity even starts.
    const html = wrap(
      JSON.stringify({ "@context": "https://schema.org", "@graph": [{ mainEntity: { "@type": "Order", orderNumber: "NESTED-OK" } }] }),
    );
    expect(extractSchemaOrgFromHtml(html).orders[0]?.orderNumber).toBe("NESTED-OK");
  });

  it("bounds how many entities one email can contribute", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ "@type": "Order", orderNumber: `N-${i}` }));
    const found = extractSchemaOrgFromHtml(wrap(JSON.stringify(many)));
    expect(found.orders.length).toBeLessThanOrEqual(50);
    expect(found.orders.length).toBeGreaterThan(0);
  });

  it("bounds how many script blocks one email can contribute", () => {
    const block = `<script type="application/ld+json">${JSON.stringify({ "@type": "Order", orderNumber: "B" })}</script>`;
    const found = extractSchemaOrgFromHtml(`<html><body>${block.repeat(100)}</body></html>`);
    expect(found.blocksSeen).toBeLessThanOrEqual(20);
  });

  it("clamps an absurdly long string rather than storing it", () => {
    const found = extractSchemaOrgFromHtml(
      wrap(JSON.stringify({ "@type": "Order", orderNumber: "A".repeat(10_000) })),
    );
    expect(found.orders[0]!.orderNumber!.length).toBeLessThanOrEqual(512);
  });

  it("is not fooled by a script tag that is not ld+json", () => {
    const html = `<html><body><script type="text/javascript">var order = {"@type":"Order","orderNumber":"NOPE"};</script></body></html>`;
    const found = extractSchemaOrgFromHtml(html);
    expect(found.blocksSeen).toBe(0);
    expect(found.orders).toHaveLength(0);
  });

  it("handles null, undefined and non-string input without throwing", () => {
    expect(extractSchemaOrgFromHtml(null)).toEqual(EMPTY);
    expect(extractSchemaOrgFromHtml(undefined)).toEqual(EMPTY);
    expect(extractSchemaOrgFromHtml("")).toEqual(EMPTY);
  });
});

const EMPTY = { orders: [], parcels: [], reservations: [], blocksSeen: 0, blocksRejected: 0 };
