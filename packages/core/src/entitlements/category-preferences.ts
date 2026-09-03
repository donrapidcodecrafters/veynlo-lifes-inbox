import { z } from "zod";

/**
 * PERS-003 "Category preferences" — "Choose interest/attention intensity by purchases, family, travel,
 * home, finance, etc." The spec's own list is illustrative ("etc."), not exhaustive; this is the concrete
 * set Veynlo actually implements a distinct extractor/domain for today. Each key maps to one or more of
 * `IngestionService.classifyAndExtract`'s domain-classifier labels (see CATEGORY_DOMAIN_EXTRACTION_DOMAINS
 * below) — deliberately the SAME granularity as the existing plan-entitlement gates
 * (purchases_returns_tracking, subscriptions_bills_tracking, travel_planning, family_school_sharing,
 * health_logistics, pet_tracking) so a category can be disabled by the user independent of, and in
 * addition to, whatever their plan already allows. "home" (warranty tracking) has no entitlement gate
 * today, so it's the one category whose only gate is this user-level preference.
 */
export const CategoryDomainKeySchema = z.enum(["purchases", "finance", "travel", "family", "home", "health", "pets"]);
export type CategoryDomainKey = z.infer<typeof CategoryDomainKeySchema>;

export const CATEGORY_DOMAIN_KEYS: CategoryDomainKey[] = CategoryDomainKeySchema.options;

/** Maps each user-facing category to the `IngestionService.classifyAndExtract` domain-classifier labels
 * it gates. A domain-classifier label not listed here (e.g. "shipment", "calendar_event") is never gated
 * by a category preference — it stays gated only by whatever entitlement already applies to it (or by
 * nothing, if none does), the same posture it has today. */
export const CATEGORY_DOMAIN_EXTRACTION_DOMAINS: Record<CategoryDomainKey, string[]> = {
  purchases: ["receipt", "store_credit"],
  finance: ["bill", "subscription"],
  travel: ["travel"],
  family: ["school"],
  home: ["warranty"],
  health: ["health_appointment"],
  pets: ["pet"],
};

export interface CategoryDomainCopy {
  label: string;
  /** PERS-003 "Disabling a category ... explains retained existing data" — the spec's own example phrasing
   * style ("We reminded you because...") reused here: plain, specific, and names exactly what's kept. */
  disableExplanation: string;
}

export const CATEGORY_DOMAIN_COPY: Record<CategoryDomainKey, CategoryDomainCopy> = {
  purchases: {
    label: "Purchases & returns",
    disableExplanation: "Turning this off stops new purchases, receipts, and store credits from being detected — your existing purchases stay saved.",
  },
  finance: {
    label: "Bills & subscriptions",
    disableExplanation: "Turning this off stops new bills and subscriptions from being detected — your existing bills and subscriptions stay saved.",
  },
  travel: {
    label: "Travel",
    disableExplanation: "Turning this off stops new trips and travel reservations from being detected — your existing trips stay saved.",
  },
  family: {
    label: "Family & school",
    disableExplanation: "Turning this off stops new school and family items from being detected — your existing school items stay saved.",
  },
  home: {
    label: "Home & warranties",
    disableExplanation: "Turning this off stops new warranty items from being detected — your existing warranties stay saved.",
  },
  health: {
    label: "Health",
    disableExplanation: "Turning this off stops new health appointments from being detected — your existing appointments stay saved.",
  },
  pets: {
    label: "Pets",
    disableExplanation: "Turning this off stops new pet events and vaccinations from being detected — your existing pet records stay saved.",
  },
};
