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

/**
 * MAIL-005 "Sender/template parsers" — bumped whenever `matchKnownSender`'s hardcoded-domain matching
 * logic itself changes (adding/removing a domain, changing the ambiguous-category disambiguation, etc.),
 * so `source_events.parser_version` (set by `IngestionService.classifyAndExtract` whenever `matchKnownSender`
 * actually matches) can distinguish which version of this deterministic logic produced a given event's
 * category — e.g. for auditing a correction-rate regression back to a specific logic change. Deliberately
 * a single flat integer, not a per-domain or per-template version map: `KNOWN_SENDER_DOMAINS` today is one
 * small, uniformly-maintained registry, so one version number covering the whole registry is proportionate;
 * splitting it out further would be over-building for a registry this size (see this module's own future
 * doc comment when it says a real template-versioning system is a separate, larger feature).
 */
export const KNOWN_SENDER_PARSER_VERSION = 1;

/**
 * MAIL-006 "User sender rules" — extracts the bare email address a raw "From" header carries, whether it's
 * already a plain address ("foo@bar.com") or the common "Display Name <foo@bar.com>" form. Used by sender-
 * rule matching (IngestionService.lookupSenderRule / InboxService.addSenderRuleFromInboxItem) rather than
 * `matchKnownSender`'s own inline `fromAddress.split("@")[1]`, which is left untouched here to avoid any
 * behavior change to the existing MAIL-005 registry matching this session didn't touch.
 */
export function extractEmailAddress(raw: string): string | null {
  const angleMatch = raw.match(/<([^>]+)>/);
  const candidate = (angleMatch?.[1] ?? raw).trim().toLowerCase();
  return candidate.includes("@") ? candidate : null;
}

/**
 * CAL-004 trusted-reschedule-rule scoping key — the same `fromAddress.split("@")[1]` domain extraction
 * `matchKnownSender` above uses, exported so `IngestionService.extractCalendarEvent` and
 * `InboxService`'s trusted-rule management (settings UI + the "trust this sender" action on an offered
 * reschedule) share one normalization instead of two independently-written ones drifting apart. Accepts
 * either a full email address ("reschedule@united.com") or a bare domain typed directly into a settings
 * form ("united.com" or "@united.com") — whichever the caller has on hand. Returns null for anything that
 * doesn't look like a real domain (empty, no dot, stray characters) rather than storing garbage a rule
 * could never actually match against later.
 */
export function normalizeSenderDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const domain = trimmed.includes("@") ? trimmed.split("@")[1] : trimmed.replace(/^@/, "");
  if (!domain) return null;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain) ? domain : null;
}
