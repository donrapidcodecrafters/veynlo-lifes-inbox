/**
 * Stage 0-1 of the pipeline (§39.1): deterministic prefilter + relevance
 * classifier. Cheap sender/keyword/template heuristics run before any model
 * call so mailing lists, personal conversation, and generic marketing never
 * reach the AI extraction stage (§MAIL-001, §41.4 cost control).
 */

const IRRELEVANT_LIST_HEADERS = ["list-unsubscribe", "precedence"];

const RELEVANT_KEYWORD_PATTERNS: RegExp[] = [
  /order (confirmation|number|#)/i,
  /your (receipt|invoice|order|package|shipment)/i,
  /has shipped/i,
  /out for delivery/i,
  /tracking number/i,
  /payment (due|received|confirmation)/i,
  /statement is ready/i,
  /subscription/i,
  /renew(al|s|ed)?/i,
  /appointment/i,
  /reservation/i,
  /confirmation number/i,
  /warranty/i,
  /return (window|deadline|policy)/i,
];

export interface RelevanceResult {
  relevant: boolean;
  reason: string;
}

export function evaluateRelevance(params: { subject: string; fromAddress: string; snippet: string; headers: Record<string, string> }): RelevanceResult {
  const hasListHeader = IRRELEVANT_LIST_HEADERS.some((h) => Boolean(params.headers[h]));
  const text = `${params.subject}\n${params.snippet}`;
  const matchesKeyword = RELEVANT_KEYWORD_PATTERNS.some((pattern) => pattern.test(text));

  if (matchesKeyword) {
    return { relevant: true, reason: "keyword_match" };
  }
  if (hasListHeader) {
    return { relevant: false, reason: "mailing_list_header" };
  }
  return { relevant: false, reason: "no_relevance_signal" };
}

/** Distinguishes a shipping-notification email from an order/payment receipt when both come from the same sender domain — deterministic, no AI call. */
const SHIPMENT_KEYWORD_PATTERNS: RegExp[] = [/has shipped/i, /out for delivery/i, /tracking number/i, /delivered/i, /your package/i];

type KnownSenderCategory = "receipt" | "shipment" | "ambiguous";

/**
 * Sender/template registry for the highest-volume merchants — bypasses AI
 * entirely when a strict pattern matches (§MAIL-005). Pure shipping
 * carriers (UPS/FedEx/USPS) only ever send one kind of email, so their
 * category is fixed. A domain like amazon.com sends BOTH order receipts
 * and shipping notifications from the same address — marking it
 * "ambiguous" here means `matchKnownSender` still skips the AI domain
 * classifier (staying cheap/deterministic) but disambiguates receipt vs.
 * shipment from the subject/snippet instead of assuming one category for
 * every email that domain ever sends.
 */
export const KNOWN_SENDER_DOMAINS: Record<string, { merchantName: string; category: KnownSenderCategory }> = {
  "amazon.com": { merchantName: "Amazon", category: "ambiguous" },
  "ups.com": { merchantName: "UPS", category: "shipment" },
  "fedex.com": { merchantName: "FedEx", category: "shipment" },
  "usps.com": { merchantName: "USPS", category: "shipment" },
};

export function matchKnownSender(
  fromAddress: string,
  subjectAndSnippet = "",
): { merchantName: string; category: "receipt" | "shipment" } | null {
  const domain = fromAddress.split("@")[1]?.toLowerCase().trim();
  if (!domain) return null;
  const entry = KNOWN_SENDER_DOMAINS[domain];
  if (!entry) return null;
  if (entry.category !== "ambiguous") {
    return { merchantName: entry.merchantName, category: entry.category };
  }
  const category = SHIPMENT_KEYWORD_PATTERNS.some((pattern) => pattern.test(subjectAndSnippet)) ? "shipment" : "receipt";
  return { merchantName: entry.merchantName, category };
}
