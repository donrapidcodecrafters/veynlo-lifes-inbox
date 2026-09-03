/**
 * DEC-001 "Rules/decision engine" — "Users see rule explanations such as 'We reminded you because your
 * return ends in 3 days and the item is still marked undecided.'" `AttentionItem.reasonText` (see
 * attention.ts's own doc comment) already IS that per-instance sentence — every reasonCode
 * `AttentionService.scanAndFileDeadlines` files builds a specific, non-generic reasonText citing the
 * actual dates/amounts/labels involved (see that method's own doc comments for each domain). What was
 * missing was a dedicated "View why" surface (DEC-001's own listed user action) distinct from just
 * reading the summary line, PLUS the rule-level (not instance-level) explanation of why this KIND of item
 * is ever surfaced at all — e.g. not just "your return closes in 3 days" but "returns are tracked against
 * the deadline your retailer's own policy states, and flagged as that deadline approaches."
 *
 * Keyed by `AttentionItem.reasonCode` (a plain string, not a fixed enum — see AttentionItemSchema's own
 * comment on why) so this is additive: an unrecognized future reasonCode falls back to
 * `DEFAULT_ATTENTION_REASON_EXPLANATION` rather than crashing a client that hasn't been updated yet.
 */
export interface AttentionReasonExplanation {
  /** Short label for the underlying rule/category — shown as a heading above the rule-level explanation. */
  ruleLabel: string;
  /** Generic, reasonCode-level explanation of why this KIND of item is ever surfaced at all — distinct
   * from the item's own `reasonText`, which is the specific instance ("We reminded you because..."). */
  ruleExplanation: string;
}

export const ATTENTION_REASON_EXPLANATIONS: Record<string, AttentionReasonExplanation> = {
  bill_due: {
    ruleLabel: "Bill due soon",
    ruleExplanation:
      "Veynlo tracks the due date extracted from your bill or biller email, and reminds you a few days ahead so you have time to pay before it's late. It stops reminding you the moment a matching payment is observed in a connected account.",
  },
  bill_overdue: {
    ruleLabel: "Bill overdue",
    ruleExplanation:
      "A bill escalates from \"due soon\" to \"overdue\" once its due date has passed by a short grace period (a few days, since autopay and checks don't always post exactly on time) with no matching payment observed yet in your connected accounts.",
  },
  event_reminder: {
    ruleLabel: "Upcoming event",
    ruleExplanation:
      "Veynlo reminds you before a calendar event starts, using the lead time set on that event (yours, or a sensible default) — never for an event that's been cancelled.",
  },
  trial_ending: {
    ruleLabel: "Free trial ending",
    ruleExplanation:
      "Veynlo flags a subscription trial a few days before it's scheduled to convert to a paid plan, so you can decide to keep it, cancel it, or decide later — before any charge happens.",
  },
  return_window_closing: {
    ruleLabel: "Return window closing",
    ruleExplanation:
      "Veynlo tracks the return deadline extracted from your order confirmation or the retailer's stated return policy, and reminds you as that window approaches while the item is still marked undecided (not yet kept, returned, or gifted).",
  },
  warranty_expiring: {
    ruleLabel: "Warranty expiring",
    ruleExplanation:
      "Veynlo calculates a product's warranty expiration from its purchase date and the warranty length stated on your receipt or registration, and reminds you before that coverage ends.",
  },
  equipment_return_due: {
    ruleLabel: "Equipment return due",
    ruleExplanation:
      "Some providers (e.g. an internet or cable company) require you to return leased equipment like a router or set-top box by a deadline or be charged for it. Veynlo tracks that deadline from your cancellation or equipment paperwork and reminds you before it passes.",
  },
  vehicle_recall: {
    ruleLabel: "Vehicle recall",
    ruleExplanation:
      "Veynlo checks your vehicles against public manufacturer recall data. An unconfirmed match is flagged for you to verify against your exact VIN; once you confirm it genuinely applies, it's treated as critical.",
  },
  home_asset_recall: {
    ruleLabel: "Home asset recall",
    ruleExplanation:
      "Veynlo checks appliances and other home assets you've added against public manufacturer recall data. An unconfirmed match is flagged for you to verify against your exact unit; once you confirm it genuinely applies, it's treated as critical.",
  },
  store_credit_expiring: {
    ruleLabel: "Store credit expiring",
    ruleExplanation:
      "Veynlo tracks the expiration date on a store credit from a return or refund, and reminds you before it expires unused.",
  },
  travel_credit_expiring: {
    ruleLabel: "Travel credit expiring",
    ruleExplanation:
      "Veynlo tracks the expiration date on a travel credit or voucher extracted from your airline/hotel confirmation, and reminds you before it expires unused.",
  },
  travel_document_expiring: {
    ruleLabel: "Passport validity",
    ruleExplanation:
      "Veynlo compares your passport's expiration date against your upcoming trip dates, including a common buffer many destinations informally expect beyond your travel dates. This is only ever a reminder to verify entry requirements yourself — Veynlo never asserts a specific destination's actual visa or validity rules.",
  },
  refill_due: {
    ruleLabel: "Medication refill due",
    ruleExplanation:
      "Veynlo tracks the next-refill date for a medication reminder you've set up, and reminds you a few days ahead so you don't run out.",
  },
  pet_refill_due: {
    ruleLabel: "Pet medication refill due",
    ruleExplanation:
      "Veynlo tracks the next-refill date for a pet's medication reminder, and reminds you a few days ahead so you don't run out.",
  },
  pet_vaccination_expiring: {
    ruleLabel: "Pet vaccination expiring",
    ruleExplanation:
      "Veynlo reminds you before a pet vaccination or license you've confirmed is set to expire, based on the expiration date you confirmed (an unconfirmed, evidence-only candidate is never surfaced here).",
  },
  trip_check_in_reminder: {
    ruleLabel: "Trip check-in reminder",
    ruleExplanation:
      "Veynlo reminds you to check in for a flight or lodging reservation ahead of the lead time set for that reservation.",
  },
  rental_return_due: {
    ruleLabel: "Rental return due",
    ruleExplanation:
      "Veynlo reminds you to return a rental car or similar booking before its scheduled drop-off time, with urgency increasing the closer that time gets.",
  },
  person_important_date: {
    ruleLabel: "Important date",
    ruleExplanation:
      "Veynlo reminds you ahead of a birthday, anniversary, or other important date you saved for someone in your contacts.",
  },
  // FIN-004 "Surface possible duplicate or unexpectedly different charge ... cautiously ... do not label
  // fraud based solely on model anomaly" — both explanations are deliberately careful to frame this as a
  // pattern worth a second look, never an accusation or a confirmed problem.
  financial_duplicate_charge: {
    ruleLabel: "Possible duplicate charge",
    ruleExplanation:
      "Veynlo noticed the exact same charge amount posted twice from the same merchant and account within a couple of days — sometimes a genuine duplicate (a card reader glitch, a retried payment), sometimes two separate real charges that just happened to match. It's flagged for you to confirm either way, never treated as fraud automatically.",
  },
  financial_unusual_charge: {
    ruleLabel: "Unusually high charge",
    ruleExplanation:
      "Veynlo compares a new charge against that same merchant's typical amount in your own transaction history, and flags one that's significantly higher than usual. This is only a pattern worth a second look, not an accusation — plenty of ordinary reasons (a bigger order, a price increase) explain a higher charge.",
  },
};

/** Used whenever a reasonCode isn't in the map above (e.g. a newer code an older client build doesn't
 * recognize yet) — honest about the gap rather than inventing a specific-sounding explanation for a rule
 * this client doesn't actually know about. */
export const DEFAULT_ATTENTION_REASON_EXPLANATION: AttentionReasonExplanation = {
  ruleLabel: "Needs your attention",
  ruleExplanation: "This was flagged by one of Veynlo's attention rules; see the reason above for the specific detail that triggered it.",
};

export function getAttentionReasonExplanation(reasonCode: string): AttentionReasonExplanation {
  return ATTENTION_REASON_EXPLANATIONS[reasonCode] ?? DEFAULT_ATTENTION_REASON_EXPLANATION;
}
