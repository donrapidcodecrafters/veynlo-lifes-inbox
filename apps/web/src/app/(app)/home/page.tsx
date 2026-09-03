"use client";

import { useState, type ReactNode } from "react";
import useSWR from "swr";
import Link from "next/link";
import { useTranslations, useLocale } from "next-intl";
import { getAttentionReasonExplanation } from "@veynlo/core";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { FetchError } from "@/components/ui/fetch-error";
import { formatTemporal, formatTimeOfDay, type TemporalValueLike } from "@/lib/format";
import { usePersonalizationPreferences } from "@/hooks/use-personalization";
import { useMaskedMoney } from "@/lib/financial-privacy-context";
import { SectionTabs } from "@/components/ui/section-tabs";
import { useSectionTabs } from "@/hooks/use-section-tabs";

interface AttentionItem {
  id: string;
  reasonCode: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  primaryActions: string[];
  confidenceBand: string;
  linkedResourceType: string | null;
}

// HOME-001 "small ranked queue with plain-language reason, due/expiration time, money/value at stake if
// known, confidence, source, and one or two primary actions" — found live: the API's /v1/home response
// already carried confidenceBand and linkedResourceType (every attention item AttentionService files has
// both), but this screen's own AttentionItem type never declared them and nothing rendered them, so two
// of the spec's six explicitly-required visible fields were silently missing from every item in the
// queue. Both maps below are display-only, matching AttentionService.scanAndFileDeadlines's actual
// reasonCode/confidenceBand vocabulary rather than inventing a new one.
// HOME-001 "plain-language reason ... source" — found live via this audit: AttentionService.
// scanAndFileDeadlines has filed items with linkedResourceType "calendar_event"/"recall_match"/
// "travel_credit"/"document"/"refill_reminder"/"pet_vaccination" for a while now (see its own doc
// comments — trial/recall/travel-credit/passport/refill/vaccination scans), but this map only ever had
// the original four resource types, so the fallback `?? item.linkedResourceType` rendered a raw internal
// value like "recall_match" or "refill_reminder" — the exact "no fake precision, but no raw internals
// either" gap this queue's own confidence-band label already avoids for confidenceBand.
const SOURCE_LABEL: Record<string, string> = {
  bill: "Bill",
  return_case: "Return",
  warranty: "Warranty",
  subscription: "Subscription",
  calendar_event: "Event",
  recall_match: "Recall",
  travel_credit: "Travel credit",
  document: "Document",
  refill_reminder: "Refill",
  pet_vaccination: "Pet vaccination",
  trip_segment: "Trip",
  bill_equipment_return: "Equipment return",
  financial_duplicate_charge: "Possible duplicate",
  financial_unusual_charge: "Unusual charge",
};

// FIN-004 "looks_right"/"dispute_with_bank" — the two reason codes that get their own action row below
// instead of the generic Mark handled/Dismiss pair every other attention item uses. "Looks right" is just
// this item's Resolve action under a wording that fits a charge-review context better than "Mark handled";
// "Get dispute guidance" never calls any API (there is no bank dispute API to call) — it only expands a
// client-side guidance panel, the same shape as the "Why am I seeing this?" panel already on this page.
const FINANCIAL_ANOMALY_REASON_CODES = new Set(["financial_duplicate_charge", "financial_unusual_charge"]);

const CONFIDENCE_LABEL: Record<string, string> = {
  verified: "Verified",
  high: "High confidence",
  needs_review: "Needs review",
  approximate: "Approximate",
};

interface HomeResponse {
  items: AttentionItem[];
  caughtUp: boolean;
  degraded: boolean;
  unhealthyConnections: Array<{ id: string; provider: string; health: string }>;
}

interface MyHousehold {
  household: { id: string; name: string };
  membership: { id: string };
}

interface FamilyToday {
  events: Array<{ id: string; title: string; startSort: string | null }>;
  tasks: Array<{ id: string; title: string; assignedToUserId: string | null; state: string }>;
  attentionItems: Array<{ id: string; reasonText: string; urgency: string }>;
}

interface TodayResponse {
  events: Array<{ id: string; title: string; startSort: string | null; isAllDay: boolean }>;
  tasks: Array<{ id: string; title: string; state: string }>;
  bills: Array<{ id: string; billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null }>;
  deliveries: Array<{ id: string; carrier: string; status: string; trackingNumber: string }>;
}

interface ReturnRow {
  returnCase: {
    id: string;
    state: string;
    deadlineSort: string | null;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
  };
  purchase: { id: string; orderNumber: string | null };
}

interface StoreCreditRow {
  id: string;
  redeemed: boolean;
  amountMinorUnits: number;
  currency: string;
  expirationDateSort: string | null;
  merchantName: string | null;
}

interface SavingsSummary {
  resolvedReturnsMinorUnits: number;
  redeemedStoreCreditsMinorUnits: number;
  outstandingStoreCreditsMinorUnits: number;
}

const MONEY_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000;

// PERS-002 "Home customization" — "Reorder/hide optional Home modules while Needs You safety logic
// remains accessible." "Needs You" (rendered unconditionally above, right after the connection-health
// banner) is deliberately NOT one of these keys — it can never be reordered or hidden by a stored
// preference, matching the spec's explicit carve-out. These three are exactly the modules this screen has
// ever had below Needs You.
const OPTIONAL_MODULE_KEYS = ["today", "money_at_risk", "family_today"] as const;
type OptionalModuleKey = (typeof OPTIONAL_MODULE_KEYS)[number];

interface HomeModulePreferences {
  moduleOrder: string[];
  hiddenModules: string[];
}

/** Applies a stored order/hidden-set to the fixed module list — an order missing a module (a brand-new
 * module shipped after the user last saved a preference) appends it at the end rather than dropping it,
 * so a new Home module is never silently invisible for an existing user with a saved layout. */
function resolveModuleOrder(prefs: HomeModulePreferences | undefined): OptionalModuleKey[] {
  const stored = (prefs?.moduleOrder ?? []).filter((k): k is OptionalModuleKey => (OPTIONAL_MODULE_KEYS as readonly string[]).includes(k));
  const missing = OPTIONAL_MODULE_KEYS.filter((k) => !stored.includes(k));
  return [...stored, ...missing];
}

const URGENCY_TONE: Record<AttentionItem["urgency"], "critical" | "warning" | "info" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "info",
  informational: "neutral",
};

// This page used to stack Needs You plus all three optional modules vertically with no way to jump
// between them — the same "endless scroll" complaint that led to Life's sections getting grouped behind
// a SectionTabs strip. "All" (the default) renders exactly what this page always has: Needs You first,
// then the optional modules in the user's own Settings -> Personalization order/visibility — unchanged.
// Each other tab jumps straight to one module instead. A module the user hid via Personalization keeps no
// tab of its own here either (see visibleHomeTabs below) — hiding it is still respected, just now via one
// mechanism instead of two. "Needs You" gets its own tab despite being un-hideable, since "reachable in
// one tap" and "always in the default view" both matter, and neither requires the other.
const HOME_TABS = [
  { value: "all", label: "All" },
  { value: "needs_you", label: "Needs You" },
  { value: "today", label: "Today" },
  { value: "money_at_risk", label: "Money at risk & savings" },
  { value: "family_today", label: "Household — Today" },
] as const;

export default function HomePage() {
  const t = useTranslations("home");
  // §38.2 "Dates/times ... Currency: locale-format display" — the resolved active locale (see
  // src/i18n/provider.tsx), threaded into every date/money formatting call below instead of an
  // unconfigurable browser-only guess.
  const locale = useLocale();
  // FIN-007 "Financial privacy mode ... Mask by default" — this hook's own doc comment already names Home
  // as a covered surface, but no call site here was ever actually wired to it (found live via manual QA:
  // turning the mode on masked amounts on /life but left every dollar figure on /home fully visible).
  const maskedMoney = useMaskedMoney();
  const { data, error, isLoading, mutate } = useSWR<HomeResponse>("/v1/home", swrFetcher);
  const { data: myHouseholds } = useSWR<MyHousehold[]>("/v1/households", swrFetcher);
  const myHousehold = myHouseholds?.[0] ?? null;
  const { data: familyToday } = useSWR<FamilyToday | null>(myHousehold ? `/v1/households/${myHousehold.household.id}/today` : null, swrFetcher);
  const { data: today, mutate: mutateToday } = useSWR<TodayResponse>("/v1/today", swrFetcher);
  const { data: returns, mutate: mutateReturns } = useSWR<ReturnRow[]>("/v1/returns", swrFetcher);
  const { data: storeCredits, mutate: mutateCredits } = useSWR<StoreCreditRow[]>("/v1/store-credits", swrFetcher);
  const { data: savings, mutate: mutateSavings } = useSWR<SavingsSummary>("/v1/savings-summary", swrFetcher);
  // DEC-001 "View why" — which item's rule-level explanation panel is currently expanded, if any.
  const [whyOpenId, setWhyOpenId] = useState<string | null>(null);
  // FIN-004 "dispute_with_bank ... shows guidance text, never automates an actual dispute" — which item's
  // guidance panel is expanded, mirroring whyOpenId's shape exactly (client-only, no API call).
  const [disputeGuidanceOpenId, setDisputeGuidanceOpenId] = useState<string | null>(null);
  // PERS-002 "Home customization" — per-user order/visibility for the optional modules below Needs You.
  const { data: modulePrefs } = useSWR<HomeModulePreferences>("/v1/home-module-preferences", swrFetcher);
  const moduleOrder = resolveModuleOrder(modulePrefs);
  const hiddenModules = new Set(modulePrefs?.hiddenModules ?? []);
  // PERS-004 "time format" — threaded into every date/time formatted on this page instead of an
  // unconfigurable browser-locale guess.
  const { data: personalization } = usePersonalizationPreferences();
  const [homeTab, setHomeTab] = useSectionTabs(HOME_TABS, "all");
  // A hidden module (Settings -> Personalization) keeps no tab of its own — "needs_you" and "all" are
  // always offered since Needs You can never be hidden.
  const visibleHomeTabs = HOME_TABS.filter((t) => t.value === "all" || t.value === "needs_you" || !hiddenModules.has(t.value));

  async function handleResolve(id: string) {
    await api.post(`/v1/attention/${id}/resolve`);
    mutate();
  }

  async function handleDismiss(id: string) {
    await api.post(`/v1/attention/${id}/dismiss`, { reason: "not_relevant" });
    mutate();
  }

  async function handleCompleteTask(id: string) {
    await api.post(`/v1/tasks/${id}/complete`);
    mutateToday();
  }

  async function handleResolveReturn(id: string) {
    await api.post(`/v1/returns/${id}/resolve`);
    // Both calls matter — a return moving to "resolved" state changes what expiringReturns filters to
    // AND changes the validated-savings total (savingsSummary sums resolved returns), so leaving the
    // second one out (found live: the whole section briefly vanished instead of showing the updated
    // "saved so far" total) understates what just happened.
    mutateReturns();
    mutateSavings();
  }

  async function handleRedeemCredit(id: string) {
    await api.post(`/v1/store-credits/${id}/redeem`);
    mutateCredits();
    mutateSavings();
  }

  const todayCount = today ? today.events.length + today.tasks.length + today.bills.length + today.deliveries.length : 0;

  // HOME-003 "Money at risk and savings" — expiring returns/credits within a 30-day lookahead, soonest
  // first. Price-adjustment opportunities/cancellation-savings/unusual-increase detection have no
  // implementation anywhere in this codebase (no opportunity/price-observation-comparison engine exists —
  // see RET-004's own gap) and are deliberately not faked here; this surfaces only the two "expiring
  // returns/credits" and "validated savings already achieved" pieces of the spec that real data backs.
  const now = Date.now();
  const expiringReturns = (returns ?? [])
    .filter((r) => r.returnCase.state === "eligible" && r.returnCase.deadlineSort && new Date(r.returnCase.deadlineSort).getTime() - now <= MONEY_LOOKAHEAD_MS)
    .sort((a, b) => new Date(a.returnCase.deadlineSort!).getTime() - new Date(b.returnCase.deadlineSort!).getTime());
  const expiringCredits = (storeCredits ?? [])
    .filter((c) => !c.redeemed && c.expirationDateSort && new Date(c.expirationDateSort).getTime() - now <= MONEY_LOOKAHEAD_MS)
    .sort((a, b) => new Date(a.expirationDateSort!).getTime() - new Date(b.expirationDateSort!).getTime());
  const validatedSavingsMinorUnits = savings ? savings.resolvedReturnsMinorUnits + savings.redeemedStoreCreditsMinorUnits : 0;
  const hasMoneySection = expiringReturns.length > 0 || expiringCredits.length > 0 || validatedSavingsMinorUnits > 0;

  // PERS-002 — each optional module as a self-contained node (or null when it has nothing to show), so
  // they can be rendered in whatever order/visibility the user has configured instead of a fixed sequence.
  const moduleNodes: Partial<Record<OptionalModuleKey, ReactNode>> = {
    today:
      today && todayCount > 0 ? (
        <section aria-labelledby="today-heading">
          <h2 id="today-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
            {t("today")}
          </h2>
          <Card>
            <CardBody className="space-y-3">
              {today.events.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Events</p>
                  {today.events.map((e) => (
                    <Link key={e.id} href={`/life/events/${e.id}`} className="block text-sm text-primary hover:underline">
                      {e.title}
                      {e.startSort && !e.isAllDay && (
                        <span className="text-tertiary"> — {formatTimeOfDay(new Date(e.startSort), personalization.timeFormat, locale)}</span>
                      )}
                    </Link>
                  ))}
                </div>
              )}
              {today.tasks.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Tasks due today</p>
                  {today.tasks.map((t) => (
                    <div key={t.id} className="flex items-center justify-between gap-2">
                      <p className="text-sm text-primary">{t.title}</p>
                      <Button size="sm" variant="ghost" onClick={() => handleCompleteTask(t.id)}>
                        Mark done
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {today.bills.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Bills due today</p>
                  {today.bills.map((b) => (
                    <Link key={b.id} href={`/life/bills/${b.id}`} className="block text-sm text-primary hover:underline">
                      {b.billerLabel}
                      {maskedMoney(b.amountDueMinorUnits, b.amountDueCurrency, locale) && (
                        <span className="text-tertiary"> — {maskedMoney(b.amountDueMinorUnits, b.amountDueCurrency, locale)}</span>
                      )}
                    </Link>
                  ))}
                </div>
              )}
              {today.deliveries.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Deliveries expected today</p>
                  {today.deliveries.map((d) => (
                    <p key={d.id} className="text-sm text-primary">
                      {d.carrier} — {d.trackingNumber}
                    </p>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </section>
      ) : null,
    money_at_risk: hasMoneySection ? (
      <section aria-labelledby="money-heading">
        <h2 id="money-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
          {t("moneyAtRisk")}
        </h2>
        <Card>
          <CardBody className="space-y-3">
            {validatedSavingsMinorUnits > 0 && (
              <p className="text-sm text-primary">
                <span className="font-semibold">{maskedMoney(validatedSavingsMinorUnits, "USD", locale)}</span>{" "}
                <span className="text-tertiary">saved so far (confirmed returns and redeemed credits).</span>
              </p>
            )}
            {expiringReturns.length > 0 && (
              <div>
                <p className="text-xs font-medium text-tertiary">Returns closing soon</p>
                {expiringReturns.map((r) => {
                  const value = maskedMoney(r.returnCase.valueAtStakeMinorUnits, r.returnCase.valueAtStakeCurrency, locale);
                  return (
                    <div key={r.returnCase.id} className="flex items-center justify-between gap-2 py-0.5">
                      <p className="text-sm text-primary">
                        Order {r.purchase.orderNumber ?? r.purchase.id}
                        {value && <span className="text-tertiary"> — {value}</span>}
                        {r.returnCase.deadlineSort && <span className="text-tertiary"> — closes {new Date(r.returnCase.deadlineSort).toLocaleDateString()}</span>}
                      </p>
                      <Button size="sm" variant="ghost" onClick={() => handleResolveReturn(r.returnCase.id)}>
                        Mark resolved
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {expiringCredits.length > 0 && (
              <div>
                <p className="text-xs font-medium text-tertiary">Store credits expiring soon</p>
                {expiringCredits.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 py-0.5">
                    <p className="text-sm text-primary">
                      {c.merchantName ?? "Store credit"} — {maskedMoney(c.amountMinorUnits, c.currency, locale)}
                      {c.expirationDateSort && <span className="text-tertiary"> — expires {new Date(c.expirationDateSort).toLocaleDateString()}</span>}
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => handleRedeemCredit(c.id)}>
                      Mark redeemed
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </section>
    ) : null,
    family_today:
      myHousehold && familyToday && (familyToday.events.length > 0 || familyToday.tasks.length > 0 || familyToday.attentionItems.length > 0) ? (
        <section aria-labelledby="family-today-heading">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="family-today-heading" className="text-sm font-semibold uppercase tracking-wide text-tertiary">
              {myHousehold.household.name} — Today
            </h2>
            <Link href="/settings/household" className="text-xs font-medium text-brand hover:underline">
              Manage household →
            </Link>
          </div>
          <Card>
            <CardBody className="space-y-3">
              {familyToday.events.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Events</p>
                  {familyToday.events.map((e) => (
                    <p key={e.id} className="text-sm text-primary">
                      {e.title}
                    </p>
                  ))}
                </div>
              )}
              {familyToday.tasks.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Tasks</p>
                  {familyToday.tasks.map((t) => (
                    <p key={t.id} className="text-sm text-primary">
                      {t.title}
                      {!t.assignedToUserId && <span className="text-tertiary"> — unassigned</span>}
                    </p>
                  ))}
                </div>
              )}
              {familyToday.attentionItems.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-tertiary">Needs attention</p>
                  {familyToday.attentionItems.map((a) => (
                    <p key={a.id} className="text-sm text-primary">
                      {a.reasonText}
                    </p>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </section>
      ) : null,
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">{t("title")}</h1>
        <p className="mt-1 text-sm text-tertiary">{t("subtitle")}</p>
      </header>

      <SectionTabs aria-label="Home sections" value={homeTab} onChange={setHomeTab} options={visibleHomeTabs} />

      {data?.degraded && data.unhealthyConnections.length > 0 && (
        <Card className="border-warning/40 bg-warning-subtle">
          <CardBody className="flex items-center justify-between gap-3">
            {/* §38.2 "Locale: no concatenated grammar that breaks translation" — a single ICU plural
                message (count-dependent noun AND verb agreement) instead of gluing an English "s"/""
                and "need"/"needs" onto either side of an interpolated number, which can't be
                correctly reordered/pluralized in every language. */}
            <p className="text-sm text-warning-subtle-text">{t("degradedBanner", { count: data.unhealthyConnections.length })}</p>
            <Link href="/connections">
              <Button variant="secondary" size="sm">
                {t("review")}
              </Button>
            </Link>
          </CardBody>
        </Card>
      )}

      {(homeTab === "all" || homeTab === "needs_you") && (
      <section aria-labelledby="needs-you-heading">
        <h2 id="needs-you-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
          {t("needsYou")}
        </h2>

        {isLoading && (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-subtle" />
            ))}
          </div>
        )}

        {/* A 500/network failure on /v1/home previously fell through every branch below (data stays
            undefined, isLoading goes false) and rendered nothing at all under the "Needs You" heading --
            indistinguishable from a slow network tab with no feedback, and with no way to recover short of
            a full reload. Confirmed live via a mocked 500 on /v1/home. */}
        {!isLoading && error && !data && (
          <FetchError what="your home screen" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
        )}

        {/* HOME-004 "Never falsely tell a user they are caught up when the system is blind" — this used to
            render "You're caught up." unconditionally whenever the queue was empty, even while the banner
            immediately above it was reporting an unhealthy connection. That's the exact false-positive the
            spec calls out by name: a literal "you're caught up" claim sitting right next to a warning that
            the picture might be incomplete. Confirmed live by seeding a degraded connection via a fixture
            script and hitting this screen — both messages rendered together. Degraded-and-caught-up now gets
            the spec's own alternate copy instead. */}
        {!isLoading && data?.caughtUp && !data.degraded && (
          <EmptyState
            title={t("caughtUpTitle")}
            description={t("caughtUpDescription")}
            action={
              <Link href="/connections">
                <Button variant="secondary" size="sm">
                  {t("connectSource")}
                </Button>
              </Link>
            }
          />
        )}

        {!isLoading && data?.caughtUp && data.degraded && (
          <EmptyState title={t("degradedCaughtUpTitle")} description={t("degradedCaughtUpDescription")} />
        )}

        {!isLoading && data && data.items.length > 0 && (
          <ul className="space-y-3">
            {data.items.map((item) => {
              const due = formatTemporal(item.dueAt, personalization.timeFormat, locale);
              const money = maskedMoney(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency, locale);
              const whyOpen = whyOpenId === item.id;
              const explanation = getAttentionReasonExplanation(item.reasonCode);
              return (
                <li key={item.id}>
                  <Card>
                    <CardBody className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Badge>
                            {item.linkedResourceType && <span className="text-xs font-medium text-tertiary">{SOURCE_LABEL[item.linkedResourceType] ?? item.linkedResourceType}</span>}
                            <span className="text-xs text-tertiary">· {CONFIDENCE_LABEL[item.confidenceBand] ?? item.confidenceBand}</span>
                          </div>
                          <p className="text-[0.9375rem] font-medium text-primary">{item.reasonText}</p>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-tertiary">
                            {due && <span>Due {due}</span>}
                            {money && <span className="font-medium text-primary">{money} at stake</span>}
                          </div>
                        </div>
                      </div>
                      {/* DEC-001 "View why" — a dedicated action distinct from the summary line above,
                          expanding to the reasonText framed the way the spec's own example is phrased
                          ("We reminded you because...") plus the reasonCode's rule-level explanation
                          (why this KIND of item is ever surfaced, not just this instance). */}
                      {whyOpen && (
                        <div className="rounded-lg border border-border-subtle bg-subtle px-3 py-2.5 text-sm">
                          <p className="text-primary">
                            <span className="font-medium">We reminded you because</span> {item.reasonText.replace(/\.$/, "").toLowerCase()}.
                          </p>
                          <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-tertiary">{explanation.ruleLabel}</p>
                          <p className="mt-1 text-tertiary">{explanation.ruleExplanation}</p>
                        </div>
                      )}
                      {/* FIN-004 "explain why flagged and ask user to confirm ... looks_right /
                          dispute_with_bank" — a duplicate/unusual-charge item gets its own action pair
                          instead of the generic Mark handled/Dismiss below, since "Mark handled" doesn't
                          read naturally for "is this charge fine?". */}
                      {FINANCIAL_ANOMALY_REASON_CODES.has(item.reasonCode) ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => handleResolve(item.id)}>
                              {t("looksRight")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-expanded={disputeGuidanceOpenId === item.id}
                              onClick={() => setDisputeGuidanceOpenId(disputeGuidanceOpenId === item.id ? null : item.id)}
                            >
                              {disputeGuidanceOpenId === item.id ? t("hideDisputeGuidance") : t("getDisputeGuidance")}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => handleDismiss(item.id)}>
                              {t("dismiss")}
                            </Button>
                          </div>
                          {disputeGuidanceOpenId === item.id && (
                            <div className="rounded-lg border border-border-subtle bg-subtle px-3 py-2.5 text-sm text-tertiary">
                              <p>
                                Veynlo can&apos;t file a dispute for you — only your bank or card issuer can. If this charge is wrong: contact
                                your bank or card issuer&apos;s fraud/dispute line (often on the back of your card or in their app), reference
                                this exact charge, amount, and date, and ask them to open a dispute or chargeback. Most issuers give you 60
                                days from the statement date to dispute a charge, so it&apos;s worth doing sooner rather than later.
                              </p>
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" onClick={() => handleResolve(item.id)}>
                            {t("markHandled")}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => handleDismiss(item.id)}>
                            {t("dismiss")}
                          </Button>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-expanded={whyOpen}
                          onClick={() => setWhyOpenId(whyOpen ? null : item.id)}
                        >
                          {whyOpen ? t("hideWhy") : t("whyAmISeeingThis")}
                        </Button>
                      </div>
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}

      {/* PERS-002 "Home customization" — "Reorder/hide optional Home modules while Needs You safety
          logic remains accessible." Needs You above is fixed; these three render in whatever order the
          user configured in Settings -> Home layout (default: Today, Money at risk & savings,
          Household — Today, same as this screen's original fixed order), skipping any the user hid.
          Unchanged for the "all" tab; a specific module tab jumps straight to that one module instead
          (still skipped if the user hid it — see visibleHomeTabs above for why its tab wouldn't even be
          offered in that case). */}
      {homeTab === "all" && moduleOrder.map((key) => (hiddenModules.has(key) ? null : <div key={key}>{moduleNodes[key]}</div>))}
      {homeTab !== "all" && homeTab !== "needs_you" && !hiddenModules.has(homeTab) && <div>{moduleNodes[homeTab]}</div>}
    </div>
  );
}
