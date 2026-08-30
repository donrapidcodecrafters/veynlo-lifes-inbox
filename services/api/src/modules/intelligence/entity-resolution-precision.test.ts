import { describe, expect, it } from "vitest";
import { normalizeMerchantName } from "../admin/admin.service";
import { normalizePersonName } from "../people/people.service";

/**
 * §54.2 launch criteria #7 "deduplication/entity resolution meets precision targets for launch domains" —
 * a real, measured precision check against a hand-labeled dataset, not just a code-review assertion that
 * the matching logic "looks conservative." Every match candidate this codebase generates (merchant
 * duplicates in AdminService, person duplicates in PeopleService, purchase/bill re-matching in
 * IngestionService) reduces to the same shape: two names are candidates for merge iff their normalized
 * forms are equal. This measures precision — of the pairs the normalizer says are the same entity, what
 * fraction genuinely are — against a labeled set covering the real formatting variance seen in practice
 * (case, punctuation, legal suffixes, domain/POS-terminal noise) plus deliberately adversarial near-miss
 * negatives a naive matcher could wrongly conflate.
 *
 * §40.2's own "precision-first, false non-merge preferable to false merge" stance sets the real target:
 * 100% precision on this set, not just "mostly right." A recall miss (two genuine duplicates that don't
 * normalize to the same key, e.g. a nickname) is an acceptable, expected limitation of exact-normalization
 * matching — it just means no auto-suggested merge, not a wrong one. A precision miss (two different real
 * entities normalizing to the same key) is the actual bug this test exists to catch, since that's what
 * corrupts data across every downstream Ask/Timeline/Life answer touching the wrongly-merged entity.
 */
interface LabeledPair {
  a: string;
  b: string;
  /** Are `a` and `b` genuinely the same real-world entity? */
  sameEntity: boolean;
}

const MERCHANT_PAIRS: LabeledPair[] = [
  // Real formatting variance the same merchant produces across different receipt emails/statement lines.
  { a: "Amazon.com", b: "AMAZON MKTPLACE PMTS", sameEntity: true },
  { a: "Amazon, Inc.", b: "amazon.com", sameEntity: true },
  { a: "Target Corp", b: "TARGET CORPORATION", sameEntity: false }, // "corporation" isn't in the suffix list — an honest recall miss, not asserted as a match
  { a: "T-Mobile", b: "TMobile", sameEntity: true },
  { a: "Whole Foods Market", b: "WHOLE FOODS MARKET", sameEntity: true },
  { a: "Best Buy Co", b: "Best Buy", sameEntity: true },
  { a: "Netflix.com", b: "NETFLIX", sameEntity: true },
  // Adversarial: genuinely different merchants a careless matcher (substring/fuzzy) could wrongly conflate.
  { a: "Target", b: "Target Optical", sameEntity: false },
  { a: "Amazon", b: "Amazon Fresh", sameEntity: false },
  { a: "Chase", b: "Chase Auto Finance", sameEntity: false },
  { a: "Apple", b: "Apple Federal Credit Union", sameEntity: false },
  { a: "Wells Fargo", b: "Wells Fargo Advisors", sameEntity: false },
];

const PERSON_PAIRS: LabeledPair[] = [
  { a: "John Smith", b: "JOHN SMITH", sameEntity: true },
  { a: "Mary-Jane Watson", b: "Mary Jane Watson", sameEntity: true },
  { a: "Dr. Sarah Chen", b: "dr sarah chen", sameEntity: true },
  // Adversarial: distinct people with similar names — punctuation-only normalization must not conflate them.
  { a: "John Smith", b: "John Smithson", sameEntity: false },
  { a: "Jon Smith", b: "John Smith", sameEntity: false }, // real recall miss (nickname), not a false merge
  { a: "Sarah Chen", b: "Sara Chen", sameEntity: false },
  { a: "James Bond", b: "James Bonds", sameEntity: false },
];

function measurePrecision(pairs: LabeledPair[], normalize: (name: string) => string): { precision: number; flaggedCount: number } {
  const flagged = pairs.filter((p) => normalize(p.a) === normalize(p.b));
  const truePositives = flagged.filter((p) => p.sameEntity).length;
  return { precision: flagged.length === 0 ? 1 : truePositives / flagged.length, flaggedCount: flagged.length };
}

describe("entity resolution — measured precision against a labeled dataset", () => {
  it("merchant matching (AdminService.normalizeMerchantName) has 100% precision on this labeled set", () => {
    const { precision, flaggedCount } = measurePrecision(MERCHANT_PAIRS, normalizeMerchantName);
    expect(flaggedCount).toBeGreaterThan(0); // sanity — the set must actually exercise some true positives
    expect(precision).toBe(1);
  });

  it("person matching (PeopleService.normalizePersonName) has 100% precision on this labeled set", () => {
    const { precision, flaggedCount } = measurePrecision(PERSON_PAIRS, normalizePersonName);
    expect(flaggedCount).toBeGreaterThan(0);
    expect(precision).toBe(1);
  });

  it("documents the real recall limitation — exact-normalization matching cannot catch legal-suffix or nickname variance beyond what's explicitly stripped", () => {
    // These are genuine same-entity pairs that do NOT normalize equal today — intentionally not asserted
    // as matches above. Captured here so a future normalizer change that starts catching them is a visible,
    // deliberate improvement rather than an unnoticed behavior change either way.
    expect(normalizeMerchantName("Target Corp")).not.toBe(normalizeMerchantName("Target Corporation"));
    expect(normalizePersonName("Jon Smith")).not.toBe(normalizePersonName("John Smith"));
  });
});
