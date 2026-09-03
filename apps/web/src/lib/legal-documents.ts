/**
 * §51.3 "Documents/policies required before public launch" lists these by name. None of the actual legal
 * text exists in this repository, and it shouldn't be fabricated here — SECURITY.md already tracks "write
 * and publish a real privacy policy + terms of service, reviewed by counsel" as an explicit open item, and
 * that's true of every document below, not just those two. What *is* buildable without counsel or a real
 * production domain is an honest placeholder route for each one, so the real app has somewhere to link to
 * and a visitor gets a truthful "not published yet" answer instead of a 404. See
 * `apps/web/src/components/legal-placeholder-page.tsx` for the shared page shell, and SECURITY.md's
 * pre-submission checklist for the still-outstanding real-content work.
 *
 * Excluded on purpose: §51.3 also names "app-store privacy/data-safety disclosures" — that's a form filled
 * out inside App Store Connect / Google Play Console, not a page this web app serves, so it has no route
 * here (tracked instead in SECURITY.md's pre-submission checklist).
 */

export const LEGAL_CONTACT_EMAIL = "don@rapidcodecrafters.com";

export interface LegalDocument {
  /** URL path segment, e.g. "terms" -> /terms */
  slug: string;
  /** Heading and <title>. */
  title: string;
  /** One-line description of what this document will eventually cover, for the placeholder body copy. */
  summary: string;
}

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    slug: "terms",
    title: "Terms of Service",
    summary: "the rules for using Veynlo and the agreement between you and Veynlo",
  },
  {
    slug: "privacy-policy",
    title: "Privacy Policy",
    summary: "what data Veynlo collects, why, and how it's used, shared, and retained",
  },
  {
    slug: "subscription-terms",
    title: "Subscription & Auto-Renewal Terms",
    summary: "how paid plans, billing cycles, trials, and auto-renewal work",
  },
  {
    slug: "acceptable-use-policy",
    title: "Acceptable Use Policy",
    summary: "what you can and can't do with Veynlo",
  },
  {
    slug: "security-overview",
    title: "Security Overview",
    summary: "a plain-language summary of how Veynlo protects your data",
  },
  {
    slug: "subprocessors",
    title: "Subprocessor List",
    summary: "the third-party service providers Veynlo uses to process your data",
  },
  {
    slug: "data-retention-policy",
    title: "Data Retention & Deletion Policy",
    summary: "how long Veynlo keeps different kinds of data, and how deletion works",
  },
  {
    slug: "cookie-policy",
    title: "Cookie & Web Tracking Policy",
    summary: "what cookies and similar web tracking technology Veynlo's website and app use",
  },
  {
    slug: "accessibility",
    title: "Accessibility Statement",
    summary: "Veynlo's commitment to accessibility and how to report accessibility issues",
  },
  {
    slug: "responsible-disclosure",
    title: "Vulnerability Disclosure Policy",
    summary: "how to responsibly report a security vulnerability, and what to expect after you do",
  },
  {
    slug: "law-enforcement-requests",
    title: "Law Enforcement Request Policy",
    summary: "how Veynlo handles legal requests for user data from law enforcement or government bodies",
  },
  {
    slug: "family-child-data",
    title: "Family & Child Data Disclosures",
    summary: "how Veynlo's family/dependent features handle a child or dependent's data, and guardian controls",
  },
  {
    slug: "partner-data-processing",
    title: "Partner Data-Processing Terms",
    summary: "the data-processing terms Veynlo offers business/integration partners",
  },
  {
    slug: "dmca",
    title: "Copyright / DMCA Policy",
    summary: "how to submit a copyright infringement notice or counter-notice for user-saved content",
  },
];

export function getLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((doc) => doc.slug === slug);
}
