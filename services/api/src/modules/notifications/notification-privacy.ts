// Matches money()'s exact output in attention.service.ts ("45.00 USD") plus a plain `$`-prefixed form
// (e.g. "$45.00", "$1,234.56") for bodies written with a dollar sign directly.
const AMOUNT_PATTERN = /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\b\d{1,3}(?:,\d{3})*\.\d{2}\s+[A-Z]{3}\b/g;
const AMOUNT_PLACEHOLDER = "[amount hidden]";

// Matches the real `category` values notification-creation call sites pass (see the `category:` grep
// across ingestion.service.ts, notification-dispatch.service.ts, billing.service.ts) — not a guess.
const CATEGORY_LABELS: Record<string, string> = {
  purchase: "Purchase update",
  shipment: "Shipment update",
  bill: "Bill reminder",
  subscription: "Subscription update",
  appointment: "Appointment reminder",
  warranty: "Warranty update",
  task: "Task reminder",
  daily_brief: "Your brief is ready",
  weekly_brief: "Your brief is ready",
  billing: "Account update",
};
const DEFAULT_CATEGORY_LABEL = "Veynlo update";

const GENERIC_TITLE = "Veynlo";
const GENERIC_BODY = "You have a new notification. Open the app for details.";

/**
 * Lock-screen privacy ladder (notificationPreferences.privacyLevel) — each level is cumulative with the
 * one before it. Pulled out as a pure function (no DB/DI) so it's independently unit-testable, same
 * convention as isWithinQuietHours in quiet-hours.ts.
 */
export function applyPrivacyLevel(
  title: string,
  body: string,
  category: string | null,
  privacyLevel: string,
): { title: string; body: string } {
  if (privacyLevel === "generic") {
    return { title: GENERIC_TITLE, body: GENERIC_BODY };
  }
  if (privacyLevel === "hide_titles") {
    return {
      title: (category && CATEGORY_LABELS[category]) ?? DEFAULT_CATEGORY_LABEL,
      body: body.replace(AMOUNT_PATTERN, AMOUNT_PLACEHOLDER),
    };
  }
  if (privacyLevel === "hide_amounts") {
    return { title, body: body.replace(AMOUNT_PATTERN, AMOUNT_PLACEHOLDER) };
  }
  return { title, body };
}
