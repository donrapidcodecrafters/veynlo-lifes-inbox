/**
 * UTIL-001 "Track electric, gas, water, sewer, trash, internet, mobile, cable/satellite and security
 * bills" — a small, deliberately conservative keyword heuristic over a biller's display name. Precision-
 * first, same stance as every other best-effort matcher in this codebase (findOrCreateMerchant,
 * findExistingBill's normalize()): a biller name the heuristic doesn't recognize returns `null` rather than
 * a guessed category, since a wrong category would misfile an unrelated bill (e.g. a gym membership
 * matching "fitness") into the utility baseline-comparison/rollup views. Not an AI classification — a
 * plain keyword match is enough for the small, fairly canonical set of biller names this covers, and stays
 * deterministic/free rather than spending a model call on every bill.
 */
export type BillerCategory = "electric" | "gas" | "water" | "sewer" | "trash" | "internet" | "mobile" | "cable" | "security";

export const UTILITY_BILLER_CATEGORIES: readonly BillerCategory[] = [
  "electric",
  "gas",
  "water",
  "sewer",
  "trash",
  "internet",
  "mobile",
  "cable",
  "security",
];

const BILLER_CATEGORY_LABELS: Record<BillerCategory, string> = {
  electric: "Electric",
  gas: "Gas",
  water: "Water",
  sewer: "Sewer",
  trash: "Trash",
  internet: "Internet",
  mobile: "Mobile",
  cable: "Cable",
  security: "Security",
};

export function billerCategoryLabel(category: string | null): string | null {
  return category && category in BILLER_CATEGORY_LABELS ? BILLER_CATEGORY_LABELS[category as BillerCategory] : null;
}

// Ordered so a more specific keyword (e.g. "natural gas") is checked before a more general one that could
// otherwise misfire on an unrelated biller name containing the same substring incidentally.
const CATEGORY_KEYWORDS: Array<{ category: BillerCategory; keywords: string[] }> = [
  { category: "electric", keywords: ["electric", "electricity", "power co", "power company", "energy company", "utility district"] },
  { category: "gas", keywords: ["natural gas", "gas company", "gas utility", "propane"] },
  { category: "sewer", keywords: ["sewer", "sewage", "wastewater"] },
  { category: "water", keywords: ["water dept", "water department", "water utility", "water works", "water district", "aqua "] },
  { category: "trash", keywords: ["trash", "waste management", "garbage", "recycling", "sanitation"] },
  { category: "security", keywords: ["security", "alarm", "adt", "simplisafe", "vivint", "home shield"] },
  { category: "cable", keywords: ["cable", "satellite tv", "directv", "dish network"] },
  { category: "mobile", keywords: ["wireless", "mobile", "cellular", "verizon", "t-mobile", "at&t", "att.com", "sprint", "cricket", "boost mobile", "mint mobile"] },
  { category: "internet", keywords: ["internet", "broadband", "fiber", "comcast", "xfinity", "spectrum", "cox communications", "centurylink", "frontier communications"] },
];

export function categorizeBiller(billerName: string | null | undefined): BillerCategory | null {
  if (!billerName) return null;
  const normalized = billerName.trim().toLowerCase();
  if (!normalized) return null;
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => normalized.includes(kw))) return category;
  }
  return null;
}
