import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useTranslation } from "react-i18next";
import { getAttentionReasonExplanation } from "@veynlo/core";
import { api, ApiError } from "@/lib/api-client";
import { useOfflineMutationQueue } from "@/lib/offline-mutation-queue";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";
import { useActiveFormattingLocale } from "@/lib/use-active-locale";
import { usePersonalizationPreferences } from "@/lib/use-personalization";
import { useMaskedMoney } from "@/lib/financial-privacy-context";
import { SectionTabs } from "@/components/section-tabs";
import { useSectionTabs } from "@/lib/use-section-tabs";

interface AttentionItem {
  id: string;
  reasonCode: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  confidenceBand: string;
  linkedResourceType: string | null;
}

// HOME-001 — parity with web home/page.tsx's identical fix: confidence and source are two of the spec's
// six required visible fields on each Needs You item, and this screen (like web) had the data from
// /v1/home but never declared or rendered it.
// HOME-001 — mirrors web's identical SOURCE_LABEL fix (see its own comment): AttentionService.
// scanAndFileDeadlines has been filing these additional resource types for a while, but this map never
// grew past the original four, so the fallback rendered a raw internal value like "recall_match".
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

// FIN-004 — mirrors web home/page.tsx's identical constant: these two reason codes get their own
// "Looks right" / "Get dispute guidance" action pair instead of the generic Mark handled/Dismiss.
const FINANCIAL_ANOMALY_REASON_CODES = new Set(["financial_duplicate_charge", "financial_unusual_charge"]);
const DISPUTE_GUIDANCE_TEXT =
  "Veynlo can't file a dispute for you — only your bank or card issuer can. If this charge is wrong: contact your bank or card issuer's fraud/dispute line (often on the back of your card or in their app), reference this exact charge, amount, and date, and ask them to open a dispute or chargeback. Most issuers give you 60 days from the statement date to dispute a charge, so it's worth doing sooner rather than later.";

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
  events: Array<{ id: string; title: string }>;
  tasks: Array<{ id: string; title: string; assignedToUserId: string | null }>;
  attentionItems: Array<{ id: string; reasonText: string }>;
}

interface TodayResponse {
  events: Array<{ id: string; title: string }>;
  tasks: Array<{ id: string; title: string }>;
  bills: Array<{ id: string; billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null }>;
  deliveries: Array<{ id: string; carrier: string; trackingNumber: string }>;
}

interface ReturnRow {
  returnCase: { id: string; state: string; deadlineSort: string | null; valueAtStakeMinorUnits: number | null; valueAtStakeCurrency: string | null };
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

// PERS-002 "Home customization" — mirrors apps/web's home/page.tsx identical constants (see that file's
// own doc comment on why "needs_you" is never one of these keys).
const OPTIONAL_MODULE_KEYS = ["today", "money_at_risk", "family_today"] as const;
type OptionalModuleKey = (typeof OPTIONAL_MODULE_KEYS)[number];

interface HomeModulePreferences {
  moduleOrder: string[];
  hiddenModules: string[];
}

function resolveModuleOrder(prefs: HomeModulePreferences | null): OptionalModuleKey[] {
  const stored = (prefs?.moduleOrder ?? []).filter((k): k is OptionalModuleKey => (OPTIONAL_MODULE_KEYS as readonly string[]).includes(k));
  const missing = OPTIONAL_MODULE_KEYS.filter((k) => !stored.includes(k));
  return [...stored, ...missing];
}

const URGENCY_TONE: Record<AttentionItem["urgency"], "critical" | "warning" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "neutral",
  informational: "neutral",
};

// Mirrors apps/web's identical Home-page HOME_TABS. "All" (the default) renders exactly what this screen
// always has: Needs You first, then the optional modules in the user's own Settings -> Personalization
// order/visibility — unchanged. Each other tab jumps straight to one module instead. A module the user hid
// via Personalization keeps no tab of its own here either (see visibleHomeTabs below) — hiding it is still
// respected, just now via one mechanism instead of two. "Needs You" gets its own tab despite being
// un-hideable, since "reachable in one tap" and "always in the default view" both matter independently.
const HOME_TABS = [
  { value: "all", label: "All" },
  { value: "needs_you", label: "Needs You" },
  { value: "today", label: "Today" },
  { value: "money_at_risk", label: "Money at risk & savings" },
  { value: "family_today", label: "Household — Today" },
] as const;

export default function HomeScreen() {
  const { theme } = useAppTheme();
  const { t } = useTranslation("translation", { keyPrefix: "home" });
  const locale = useActiveFormattingLocale();
  const [data, setData] = useState<HomeResponse | null>(null);
  const [myHousehold, setMyHousehold] = useState<MyHousehold | null>(null);
  const [familyToday, setFamilyToday] = useState<FamilyToday | null>(null);
  const [today, setToday] = useState<TodayResponse | null>(null);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [storeCredits, setStoreCredits] = useState<StoreCreditRow[]>([]);
  const [savings, setSavings] = useState<SavingsSummary | null>(null);
  const [homeModulePrefs, setHomeModulePrefs] = useState<HomeModulePreferences | null>(null);
  const { data: personalization } = usePersonalizationPreferences();
  const maskedMoney = useMaskedMoney();
  const [refreshing, setRefreshing] = useState(false);
  // Found live: onPress={() => resolve(item.id)} / dismiss(item.id) below call these with no try/catch and
  // nothing awaits them, so a failed request (network drop, or a 404 if the item was already resolved from
  // another device) becomes an unhandled promise rejection — the same full-screen crash-overlay bug class
  // fixed elsewhere in this app (documents.tsx, lists.tsx, entities.tsx, etc.).
  const [actioningId, setActioningId] = useState<string | null>(null);
  // §42.6 "Offline sync and conflict model" — maps an attention item's id to the offline-queue idempotency
  // key returned when `resolve()` couldn't reach the server and got queued instead. Cross-referenced
  // against the live queue below (`useOfflineMutationQueue`) to render a "Queued — will sync" state instead
  // of the normal action buttons, and to notice the moment it syncs or fails.
  const [queuedResolveIds, setQueuedResolveIds] = useState<Record<string, string>>({});
  const { entries: queueEntries } = useOfflineMutationQueue();
  // DEC-001 "View why" — which item's rule-level explanation panel is currently expanded, if any.
  const [whyOpenId, setWhyOpenId] = useState<string | null>(null);
  // FIN-004 "dispute_with_bank ... shows guidance text, never automates an actual dispute" — mirrors web
  // home/page.tsx's identical addition: client-only expandable panel, no API call.
  const [disputeGuidanceOpenId, setDisputeGuidanceOpenId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Distinct from the deliberate 401/session-race swallow below — a transient 500 or network error
  // previously fell into that same swallow and just left `data` null forever with no visible error, the
  // exact "renders an empty state with no retry affordance" gap this fixes. A 401 still resolves via
  // api-client.ts's own redirect and is never surfaced here.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Bug found live: `useFocusEffect` below calls `load()` without awaiting it or attaching a `.catch`,
    // so an unhandled rejection here crashes the whole screen with a full "Uncaught Error" overlay — 401
    // isn't a hypothetical, it's exactly what happens for a `load()` still in flight (or refired by focus)
    // the instant a session ends: signing out, an expired/revoked refresh token, or — reproduced via
    // Settings' real delete-account flow — the account itself being deleted out from under an in-flight
    // request. api-client.ts's 401 handling already clears the token and redirects to /sign-in in that
    // case; it also *rethrows* so a caller can show its own inline error, which this screen has no UI for
    // and doesn't need to — by the time that redirect lands this screen is unmounting anyway.
    try {
      const res = await api.get<HomeResponse>("/v1/home");
      setData(res);
      setLoadError(null);
      // HOME-002 — personal today-window view; see attention.service.ts's personalToday for why this
      // doesn't require a household (mirrors the web home page's identical addition).
      const todayRes = await api.get<TodayResponse>("/v1/today");
      setToday(todayRes);
      // HOME-003 — mirrors web home page's identical "Money at risk & savings" addition.
      const [returnsRes, creditsRes, savingsRes] = await Promise.all([
        api.get<ReturnRow[]>("/v1/returns"),
        api.get<StoreCreditRow[]>("/v1/store-credits"),
        api.get<SavingsSummary>("/v1/savings-summary"),
      ]);
      setReturns(returnsRes);
      setStoreCredits(creditsRes);
      setSavings(savingsRes);
      // PERS-002 "Home customization" — mirrors apps/web's home/page.tsx identical addition.
      const modulePrefsRes = await api.get<HomeModulePreferences>("/v1/home-module-preferences");
      setHomeModulePrefs(modulePrefsRes);
      const households = await api.get<MyHousehold[]>("/v1/households");
      const household = households[0] ?? null;
      setMyHousehold(household);
      if (household) {
        const today = await api.get<FamilyToday>(`/v1/households/${household.household.id}/today`);
        setFamilyToday(today);
      } else {
        setFamilyToday(null);
      }
    } catch (err) {
      // A 401 is handled entirely by api-client.ts (clears the token, redirects to /sign-in) — surfacing
      // it here too would just flash an error a beat before the redirect lands, so it stays swallowed.
      // Anything else (network drop, a transient 500) previously fell into that same silent swallow with
      // no visible error at all — this is the one real case that needs a user-facing message and retry.
      if (!(err instanceof ApiError) || err.status !== 401) {
        setLoadError(err instanceof ApiError ? err.message : "Please check your connection and try again.");
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // §42.6 — once a queued "Mark handled" entry disappears from the live queue (drain.ts's `drain()`
  // removes an entry the moment it syncs) or turns "failed"/conflicted, this item's optimistic "Queued —
  // will sync" state is stale: either the server now genuinely agrees it's resolved (worth a reload so it
  // actually drops off Needs You) or the sync failed (worth telling the user instead of leaving a
  // "Queued" badge on something that quietly never happened). `queueEntriesRef` avoids re-running this
  // effect on every unrelated queue change for OTHER screens' entries.
  const resolvedQueueIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const stillTracked = Object.entries(queuedResolveIds);
    if (stillTracked.length === 0) return;
    let anyResolved = false;
    const next = { ...queuedResolveIds };
    for (const [itemId, idempotencyKey] of stillTracked) {
      const entry = queueEntries.find((e) => e.id === idempotencyKey);
      if (entry && entry.status !== "failed") continue; // still pending/syncing — keep showing "Queued"
      if (!resolvedQueueIdsRef.current.has(idempotencyKey)) {
        resolvedQueueIdsRef.current.add(idempotencyKey);
        anyResolved = true;
      }
      delete next[itemId];
    }
    if (anyResolved) {
      setQueuedResolveIds(next);
      load();
    }
  }, [queueEntries, queuedResolveIds, load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function resolve(id: string) {
    setActioningId(id);
    setActionError(null);
    try {
      const result = await api.postQueueable(`/v1/attention/${id}/resolve`, undefined, "Mark handled");
      if (result.queued) {
        setQueuedResolveIds((m) => ({ ...m, [id]: result.idempotencyKey }));
      } else {
        await load();
      }
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setActioningId(null);
    }
  }

  async function dismiss(id: string) {
    setActioningId(id);
    setActionError(null);
    try {
      await api.post(`/v1/attention/${id}/dismiss`, { reason: "not_relevant" });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setActioningId(null);
    }
  }

  async function completeTodayTask(id: string) {
    setActioningId(id);
    setActionError(null);
    try {
      await api.post(`/v1/tasks/${id}/complete`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setActioningId(null);
    }
  }

  async function resolveReturn(id: string) {
    setActioningId(id);
    setActionError(null);
    try {
      await api.post(`/v1/returns/${id}/resolve`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setActioningId(null);
    }
  }

  async function redeemCredit(id: string) {
    setActioningId(id);
    setActionError(null);
    try {
      await api.post(`/v1/store-credits/${id}/redeem`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setActioningId(null);
    }
  }

  // HOME-003 "Money at risk and savings" — see web home/page.tsx's identical filtering for why
  // price-adjustment/cancellation-savings/unusual-increase detection isn't surfaced here (unbuilt
  // anywhere in this codebase).
  const nowMs = Date.now();
  const expiringReturns = returns
    .filter((r) => r.returnCase.state === "eligible" && r.returnCase.deadlineSort && new Date(r.returnCase.deadlineSort).getTime() - nowMs <= MONEY_LOOKAHEAD_MS)
    .sort((a, b) => new Date(a.returnCase.deadlineSort!).getTime() - new Date(b.returnCase.deadlineSort!).getTime());
  const expiringCredits = storeCredits
    .filter((c) => !c.redeemed && c.expirationDateSort && new Date(c.expirationDateSort).getTime() - nowMs <= MONEY_LOOKAHEAD_MS)
    .sort((a, b) => new Date(a.expirationDateSort!).getTime() - new Date(b.expirationDateSort!).getTime());
  const validatedSavingsMinorUnits = savings ? savings.resolvedReturnsMinorUnits + savings.redeemedStoreCreditsMinorUnits : 0;
  const hasMoneySection = expiringReturns.length > 0 || expiringCredits.length > 0 || validatedSavingsMinorUnits > 0;
  const moduleOrder = resolveModuleOrder(homeModulePrefs);
  const hiddenModules = new Set(homeModulePrefs?.hiddenModules ?? []);
  const [homeTab, setHomeTab] = useSectionTabs("veynlo_section_tab_home", HOME_TABS, "all");
  // A hidden module (Settings -> Personalization) keeps no tab of its own — "needs_you" and "all" are
  // always offered since Needs You can never be hidden.
  const visibleHomeTabs = HOME_TABS.filter((t) => t.value === "all" || t.value === "needs_you" || !hiddenModules.has(t.value));
  // "all" renders every optional module in the user's configured order (unchanged); "needs_you" renders
  // none (Needs You itself is handled separately above); any other tab jumps straight to that one module.
  const modulesToRender: OptionalModuleKey[] = homeTab === "all" ? moduleOrder : homeTab === "needs_you" ? [] : [homeTab];

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }} accessibilityRole="header">
          {t("title")}
        </Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>{t("subtitle")}</Text>
      </View>

      <SectionTabs accessibilityLabel="Home sections" value={homeTab} onChange={setHomeTab} options={visibleHomeTabs} />

      {/* Found live: apps/web's home page shows two pulsing skeleton bars while `isLoading`, but this
          screen showed nothing at all — no skeleton, no spinner — while `data` was still null, just a
          blank gap below the header until the first `/v1/home` response landed. These bars carry no
          information of their own, so they're hidden from the accessibility tree rather than announced as
          two blank, unlabeled elements. */}
      {(homeTab === "all" || homeTab === "needs_you") && !data && !loadError && (
        <View style={{ gap: 12 }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
        </View>
      )}

      {(homeTab === "all" || homeTab === "needs_you") && !data && loadError && <FetchError what="your home screen" message={loadError} onRetry={load} />}

      {/* Spec §6.1 lists a "connector-health exception banner" as one of Home's persistent elements, and
          apps/web/src/app/(app)/home/page.tsx already has this — mobile had no idea `degraded`/
          `unhealthyConnections` even existed (the field wasn't in HomeResponse above until now), so a
          connector silently going unhealthy was invisible here even though the exact same account showed
          the warning on web. Mirrors web's copy/behavior, except web's singular/plural text disagrees with
          its own verb ("1 connection need attention") — fixed here rather than copied verbatim. Routes to
          the same Connections screen Settings' "Connections" button already uses. */}
      {data?.degraded && data.unhealthyConnections.length > 0 && (
        <Card style={{ backgroundColor: theme.colors.warningSubtleBg, borderColor: theme.colors.warning, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            {/* §38.2 "Locale: no concatenated grammar" — i18next's native `_one`/`_other` count-keyed
                keys (see lib/i18n/en.json's home.degradedBanner_one/_other) instead of gluing an
                English "s"/"" and "need"/"needs" onto an interpolated number. */}
            <Text style={{ flex: 1, fontSize: 14, color: theme.colors.warningSubtleText }}>
              {t("degradedBanner", { count: data.unhealthyConnections.length })}
            </Text>
            <Button variant="secondary" onPress={() => router.push("/connections")}>
              {t("review")}
            </Button>
          </View>
        </Card>
      )}

      {/* HOME-004 parity with web's home/page.tsx fix — mirrors the same bug found live there: this
          unconditionally showed "You're caught up." even while the degraded banner right above it was
          reporting an unhealthy connection, the exact false-positive the spec's purpose statement calls
          out by name ("Never falsely tell a user they are caught up when the system is blind"). */}
      {(homeTab === "all" || homeTab === "needs_you") && data?.caughtUp && !data.degraded && (
        <EmptyState title={t("caughtUpTitle")} description={t("caughtUpDescription")} />
      )}

      {(homeTab === "all" || homeTab === "needs_you") && data?.caughtUp && data.degraded && (
        <EmptyState title={t("degradedCaughtUpTitle")} description={t("degradedCaughtUpDescription")} />
      )}

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {(homeTab === "all" || homeTab === "needs_you") && data && data.items.length > 0 && (
        <View style={{ gap: 12 }}>
          {data.items.map((item) => {
            const due = formatTemporal(item.dueAt, personalization.timeFormat, locale);
            const money = maskedMoney(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency);
            const whyOpen = whyOpenId === item.id;
            const explanation = getAttentionReasonExplanation(item.reasonCode);
            // §42.6 — this item's "Mark handled" is currently sitting in the offline queue.
            const queuedEntry = queuedResolveIds[item.id] ? queueEntries.find((e) => e.id === queuedResolveIds[item.id]) : undefined;
            return (
              <Card key={item.id} style={{ gap: 12 }}>
                <View style={{ gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <Badge tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Badge>
                    {item.linkedResourceType && (
                      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary }}>{SOURCE_LABEL[item.linkedResourceType] ?? item.linkedResourceType}</Text>
                    )}
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>· {CONFIDENCE_LABEL[item.confidenceBand] ?? item.confidenceBand}</Text>
                  </View>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{item.reasonText}</Text>
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    {due && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Due {due}</Text>}
                    {money && <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>{money} at stake</Text>}
                  </View>
                </View>
                {/* DEC-001 "View why" — mirrors web home/page.tsx's identical addition: a dedicated
                    expandable action, distinct from the summary line above, showing the reasonText
                    reframed in the spec's own example phrasing plus the reasonCode's rule-level
                    (not instance-level) explanation. */}
                {whyOpen && (
                  <View style={{ borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSubtle, padding: 10, gap: 4 }}>
                    <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                      <Text style={{ fontWeight: "600" }}>We reminded you because</Text> {item.reasonText.replace(/\.$/, "").toLowerCase()}.
                    </Text>
                    <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase", marginTop: 4 }}>{explanation.ruleLabel}</Text>
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{explanation.ruleExplanation}</Text>
                  </View>
                )}
                {FINANCIAL_ANOMALY_REASON_CODES.has(item.reasonCode) ? (
                  <>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <View style={{ flex: 1 }}>
                        <Button variant="secondary" onPress={() => resolve(item.id)} loading={actioningId === item.id}>
                          {t("looksRight")}
                        </Button>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button variant="ghost" onPress={() => dismiss(item.id)} loading={actioningId === item.id}>
                          {t("dismiss")}
                        </Button>
                      </View>
                    </View>
                    <Button
                      variant="ghost"
                      onPress={() => setDisputeGuidanceOpenId(disputeGuidanceOpenId === item.id ? null : item.id)}
                    >
                      {disputeGuidanceOpenId === item.id ? t("hideDisputeGuidance") : t("getDisputeGuidance")}
                    </Button>
                    {disputeGuidanceOpenId === item.id && (
                      <View style={{ borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSubtle, padding: 10 }}>
                        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{DISPUTE_GUIDANCE_TEXT}</Text>
                      </View>
                    )}
                  </>
                ) : queuedEntry ? (
                  // §42.6 "remains visibly Pending until server confirms" — replaces the action row rather
                  // than just disabling it, so it's unambiguous this already "took" locally and isn't
                  // something the user needs to retry themselves.
                  <Badge tone="neutral">{queuedEntry.status === "syncing" ? "Syncing…" : "Queued — will sync when you're back online"}</Badge>
                ) : (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button variant="secondary" onPress={() => resolve(item.id)} loading={actioningId === item.id}>
                        {t("markHandled")}
                      </Button>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button variant="ghost" onPress={() => dismiss(item.id)} loading={actioningId === item.id}>
                        {t("dismiss")}
                      </Button>
                    </View>
                  </View>
                )}
                <Button variant="ghost" onPress={() => setWhyOpenId(whyOpen ? null : item.id)}>
                  {whyOpen ? t("hideWhy") : t("whyAmISeeingThis")}
                </Button>
              </Card>
            );
          })}
        </View>
      )}

      {/* PERS-002 "Home customization" — parity with web home/page.tsx's identical addition: these three
          modules render in whichever order/visibility the user configured in Settings -> Personalization
          (default order below matches this screen's original fixed order), Needs You above stays fixed.
          Unchanged for the "all" tab; a specific module tab jumps straight to that one module instead
          (modulesToRender above — still skipped if the user hid it, same hiddenModules.has(key) guard). */}
      {modulesToRender.map((key) => {
        if (hiddenModules.has(key)) return null;
        if (key === "today") {
          // HOME-002 "Today view" — previously the only today-window surface on this screen was the
          // household card below, invisible to any solo account (confirmed live: a fresh sign-up with no
          // household got no today view at all).
          if (!today || (today.events.length === 0 && today.tasks.length === 0 && today.bills.length === 0 && today.deliveries.length === 0)) return null;
          return (
            <View key={key} style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>{t("today")}</Text>
              <Card style={{ gap: 10 }}>
                {today.events.map((e) => (
                  <Text key={e.id} style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                    {e.title}
                  </Text>
                ))}
                {today.tasks.map((t) => (
                  <View key={t.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ fontSize: 14, color: theme.colors.textPrimary, flex: 1 }}>{t.title}</Text>
                    <Button variant="ghost" onPress={() => completeTodayTask(t.id)} loading={actioningId === t.id}>
                      Mark done
                    </Button>
                  </View>
                ))}
                {today.bills.map((b) => {
                  const money = maskedMoney(b.amountDueMinorUnits, b.amountDueCurrency);
                  return (
                    <Text key={b.id} style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                      {b.billerLabel}
                      {money && <Text style={{ color: theme.colors.textTertiary }}> — {money}</Text>}
                    </Text>
                  );
                })}
                {today.deliveries.map((d) => (
                  <Text key={d.id} style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                    {d.carrier} — {d.trackingNumber}
                  </Text>
                ))}
              </Card>
            </View>
          );
        }
        if (key === "money_at_risk") {
          // HOME-003 "Money at risk and savings"
          if (!hasMoneySection) return null;
          return (
            <View key={key} style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>{t("moneyAtRisk")}</Text>
              <Card style={{ gap: 10 }}>
                {validatedSavingsMinorUnits > 0 && (
                  <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                    <Text style={{ fontWeight: "700" }}>{maskedMoney(validatedSavingsMinorUnits, "USD")}</Text> saved so far (confirmed returns and
                    redeemed credits).
                  </Text>
                )}
                {expiringReturns.map((r) => {
                  const value = maskedMoney(r.returnCase.valueAtStakeMinorUnits, r.returnCase.valueAtStakeCurrency);
                  return (
                    <View key={r.returnCase.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{ fontSize: 14, color: theme.colors.textPrimary, flex: 1 }}>
                        Order {r.purchase.orderNumber ?? r.purchase.id}
                        {value && <Text style={{ color: theme.colors.textTertiary }}> — {value}</Text>}
                      </Text>
                      <Button variant="ghost" onPress={() => resolveReturn(r.returnCase.id)} loading={actioningId === r.returnCase.id}>
                        Mark resolved
                      </Button>
                    </View>
                  );
                })}
                {expiringCredits.map((c) => (
                  <View key={c.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ fontSize: 14, color: theme.colors.textPrimary, flex: 1 }}>
                      {c.merchantName ?? "Store credit"} — {maskedMoney(c.amountMinorUnits, c.currency)}
                    </Text>
                    <Button variant="ghost" onPress={() => redeemCredit(c.id)} loading={actioningId === c.id}>
                      Mark redeemed
                    </Button>
                  </View>
                ))}
              </Card>
            </View>
          );
        }
        // key === "family_today"
        if (!myHousehold || !familyToday || (familyToday.events.length === 0 && familyToday.tasks.length === 0 && familyToday.attentionItems.length === 0)) return null;
        return (
          <View key={key} style={{ gap: 8 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
              {myHousehold.household.name} — Today
            </Text>
            <Card style={{ gap: 10 }}>
              {familyToday.events.map((e) => (
                <Text key={e.id} style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                  {e.title}
                </Text>
              ))}
              {familyToday.tasks.map((t) => (
                <Text key={t.id} style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                  {t.title}
                  {!t.assignedToUserId && <Text style={{ color: theme.colors.textTertiary }}> — unassigned</Text>}
                </Text>
              ))}
              {familyToday.attentionItems.map((a) => (
                <Text key={a.id} style={{ fontSize: 14, color: theme.colors.textPrimary }}>
                  {a.reasonText}
                </Text>
              ))}
            </Card>
          </View>
        );
      })}
    </Screen>
  );
}
