import { describe, expect, it } from "vitest";
import { extractSchemaOrgFromHtml, hasUsableMarkup } from "./schema-org-email";
import { billResultFromMarkup, domainsFromMarkup } from "./schema-org-extraction";

/**
 * The bills utilities and insurers already publish in their own notices.
 *
 * Appendix A lists 8 utilities and 6 insurers. Both groups sat in the "served by the email pipeline"
 * column, meaning a model reads the prose — so a household with AI processing off got nothing from any of
 * them, and everyone else paid for inference to recover a due date the biller had already stated in a
 * machine-readable field of the same email.
 *
 * The failure to guard against here is a wrong DUE DATE. A bill filed a week late is a late payment, a
 * fee, and sometimes a mark on somebody's credit.
 */

const wrap = (json: unknown) => `<html><body><script type="application/ld+json">${JSON.stringify(json)}</script></body></html>`;

const invoice = {
  "@context": "http://schema.org",
  "@type": "Invoice",
  accountId: "Account ending 4321",
  paymentDueDate: "2026-05-01",
  paymentStatus: "http://schema.org/PaymentDue",
  provider: { "@type": "Organization", name: "City Power & Light" },
  totalPaymentDue: { "@type": "PriceSpecification", price: "84.20", priceCurrency: "USD" },
  url: "https://citypower.test/bill/4321",
};

describe("a utility bill", () => {
  it("reads the biller, the amount and the due date", () => {
    const found = extractSchemaOrgFromHtml(wrap(invoice));
    expect(found.invoices).toHaveLength(1);
    const bill = found.invoices[0]!;
    expect(bill.billerName).toBe("City Power & Light");
    expect(bill.dueDate).toBe("2026-05-01");
    expect(bill.accountId).toBe("Account ending 4321");
    expect(bill.currency).toBe("USD");
    expect(hasUsableMarkup(found)).toBe(true);
  });

  it("scales the amount exactly, including the values a float multiply gets wrong", () => {
    // 8.20 * 100 is 819.9999999999999 in JS. Truncating gives 819 — a bill eight cents light.
    for (const [price, expected] of [
      ["84.20", 8_420],
      ["1.15", 115],
      ["8.20", 820],
    ] as const) {
      const found = extractSchemaOrgFromHtml(wrap({ ...invoice, totalPaymentDue: { price, priceCurrency: "USD" } }));
      expect(found.invoices[0]?.amountDueMinorUnits, `price "${price}"`).toBe(expected);
    }
  });

  it("reads the OLD paymentDue spelling as well as the current one", () => {
    // `paymentDueDate` is the current name. `paymentDue` is what Google's email-markup documentation used
    // for years and what senders still emit — missing it loses the due date entirely, which is the one
    // field this whole thing exists for.
    const older = { ...invoice, paymentDueDate: undefined, paymentDue: "2026-05-01" };
    expect(extractSchemaOrgFromHtml(wrap(older)).invoices[0]?.dueDate).toBe("2026-05-01");
  });

  it("reads an amount stated as a bare number rather than a price specification", () => {
    const bare = { ...invoice, totalPaymentDue: "84.20" };
    expect(extractSchemaOrgFromHtml(wrap(bare)).invoices[0]?.amountDueMinorUnits).toBe(8_420);
  });

  it("reads a MonetaryAmount, which uses `value` rather than `price`", () => {
    const monetary = { ...invoice, totalPaymentDue: { "@type": "MonetaryAmount", value: "84.20", currency: "USD" } };
    const bill = extractSchemaOrgFromHtml(wrap(monetary)).invoices[0]!;
    expect(bill.amountDueMinorUnits).toBe(8_420);
    expect(bill.currency).toBe("USD");
  });

  it("drops an impossible due date rather than repairing it", () => {
    const bad = { ...invoice, paymentDueDate: "2026-02-31" };
    const bill = extractSchemaOrgFromHtml(wrap(bad)).invoices[0]!;
    expect(bill.dueDate).toBeNull();
    // The rest of the bill is real and is kept.
    expect(bill.billerName).toBe("City Power & Light");
  });

  it("ignores an Invoice that states nothing anybody can act on", () => {
    const empty = { "@type": "Invoice", "@context": "https://schema.org", paymentStatus: "http://schema.org/PaymentDue" };
    expect(extractSchemaOrgFromHtml(wrap(empty)).invoices).toHaveLength(0);
  });
});

describe("autopay", () => {
  it("is true only when the biller declared it", () => {
    // schema.org says this outright. Inferring autopay from a sentence is a guess; being told is not.
    const auto = { ...invoice, paymentStatus: "http://schema.org/PaymentAutomaticallyApplied" };
    const result = billResultFromMarkup(extractSchemaOrgFromHtml(wrap(auto)));
    expect(result?.data.autopayMentioned).toBe(true);
  });

  it("is NULL, not false, when the biller said nothing about it", () => {
    // "Not stated" and "stated that autopay is off" are different claims, and only the first is true here.
    // Filing false would be this app asserting something the biller never said — and somebody trusting it
    // would be waiting for a payment that never happens.
    const result = billResultFromMarkup(extractSchemaOrgFromHtml(wrap(invoice)));
    expect(result?.data.autopayMentioned).toBeNull();

    const noStatus = { ...invoice, paymentStatus: undefined };
    expect(billResultFromMarkup(extractSchemaOrgFromHtml(wrap(noStatus)))?.data.autopayMentioned).toBeNull();
  });
});

describe("what the markup establishes on its own", () => {
  it("makes a declared Invoice a bill, with no model involved", () => {
    expect(domainsFromMarkup(extractSchemaOrgFromHtml(wrap(invoice)))).toContain("bill");
  });

  it("leaves the equipment-return fields for the model", () => {
    // schema.org has no vocabulary for a cable-box return window, and it is one of the few genuinely
    // costly things this app catches. Null here means the model still fills it.
    const result = billResultFromMarkup(extractSchemaOrgFromHtml(wrap(invoice)));
    expect(result?.data.equipmentReturnDeadline).toBeNull();
    expect(result?.data.equipmentReturnInstructions).toBeNull();
  });

  it("carries the biller's own account label through unchanged", () => {
    const result = billResultFromMarkup(extractSchemaOrgFromHtml(wrap(invoice)));
    expect(result?.data.accountLabel).toBe("Account ending 4321");
  });

  it("returns null when there is no invoice at all", () => {
    expect(billResultFromMarkup(extractSchemaOrgFromHtml("<html><body>hello</body></html>"))).toBeNull();
  });

  it("reads an invoice alongside an order in the same message", () => {
    const html = `<html><body>
      <script type="application/ld+json">${JSON.stringify({ "@type": "Order", orderNumber: "O-1", seller: "Shop" })}</script>
      <script type="application/ld+json">${JSON.stringify(invoice)}</script>
    </body></html>`;
    const found = extractSchemaOrgFromHtml(html);
    expect(found.orders).toHaveLength(1);
    expect(found.invoices).toHaveLength(1);
    expect(domainsFromMarkup(found).sort()).toEqual(["bill", "receipt"]);
  });
});
