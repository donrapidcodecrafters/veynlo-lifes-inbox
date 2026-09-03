import { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import type { CapabilityKey, CapabilityValue, PlanKey } from "@veynlo/core";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";

type Interval = "month" | "year";

interface EntitlementsResponse {
  planKey: PlanKey;
  capabilities: Record<CapabilityKey, CapabilityValue>;
}

interface PlanOption {
  planKey: PlanKey;
  interval: Interval;
  priceId: string;
  capabilities: Record<CapabilityKey, CapabilityValue>;
}

const PLAN_LABELS: Record<PlanKey, string> = {
  free: "Free",
  plus: "Plus",
  family: "Family",
  pro_agent: "Pro Agent",
};

// Mirrors apps/web's (app)/settings/billing/page.tsx CAPABILITY_LABELS/formatCapability exactly, so
// "What's included" reads the same across platforms — this app fetched entitlements but never rendered
// them (confirmed live: the Billing screen showed only "Current plan" and the Plans list, with no way to
// see what the current plan actually included).
const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  email_connections_max: "Email connections",
  calendar_connections_max: "Calendar connections",
  historical_backfill_days: "History backfill",
  ask_queries_per_day: "Ask queries per day",
  document_storage_mb: "Document storage",
  purchases_returns_tracking: "Purchase & return tracking",
  subscriptions_bills_tracking: "Subscription & bill tracking",
  financial_aggregator_connections_max: "Bank connections",
  cloud_storage_connections_max: "Cloud storage connections",
  home_vehicle_profiles: "Home & vehicle profiles",
  family_school_sharing: "Family & school sharing",
  automation_rules_max: "Automation rules",
  emergency_binder: "Emergency binder",
  data_export: "Data export",
  desktop_power_tools: "Desktop power tools",
  household_members_max: "Household members",
  health_logistics: "Health logistics",
  travel_planning: "Travel & reservations",
  pet_tracking: "Pets",
  identity_records: "Identity & legal documents",
};

function formatCapability(key: CapabilityKey, value: CapabilityValue): string {
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  if (value === null) return "Unlimited";
  if (key === "document_storage_mb") return value >= 1000 ? `${(value / 1000).toFixed(0)} GB` : `${value} MB`;
  if (key === "historical_backfill_days") return `${value} days`;
  return String(value);
}

export default function BillingScreen() {
  const { theme } = useAppTheme();
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | undefined>(undefined);
  const [plans, setPlans] = useState<PlanOption[] | undefined>(undefined);
  const [pendingPlan, setPendingPlan] = useState<PlanKey | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Entitlements and plans load independently, and each has its own error text below. Confirmed live: both
  // used to funnel into this same `error` state — if the two fetches failed close together, whichever
  // `.catch` ran last silently clobbered the other's message, so a real "couldn't load your plan" failure
  // could vanish entirely behind "couldn't load available plans" (or vice versa) with no sign anything else
  // had gone wrong. Kept separate from the plans-load error below so both can surface at once.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [intervalByPlan, setIntervalByPlan] = useState<Partial<Record<PlanKey, Interval>>>({});

  useEffect(() => {
    // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx): a `.then` with no `.catch` on a
    // mount-time fetch becomes an unhandled promise rejection on any transient network failure, which
    // React Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not
    // just this screen.
    api
      .get<EntitlementsResponse>("/v1/billing/entitlements")
      .then(setEntitlements)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your plan. Please try again."));
    api
      .get<PlanOption[]>("/v1/billing/plans")
      .then(setPlans)
      .catch((err) => setPlansError(err instanceof ApiError ? err.message : "Couldn't load available plans. Please try again."));
  }, []);

  async function subscribe(plan: PlanOption) {
    setError(null);
    setPendingPlan(plan.planKey);
    try {
      const { url } = await api.post<{ url: string }>("/v1/billing/checkout-session", {
        planKey: plan.planKey,
        priceId: plan.priceId,
      });
      await Linking.openURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start checkout. Please try again.");
    } finally {
      setPendingPlan(null);
    }
  }

  async function manageBilling() {
    setError(null);
    setPortalLoading(true);
    try {
      const { url } = await api.post<{ url: string }>("/v1/billing/portal-session");
      await Linking.openURL(url);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "NO_BILLING_ACCOUNT"
          ? // NO_BILLING_ACCOUNT just means "no Stripe customer id on file" — true both for a free user who's
            // never checked out AND for a paid user whose plan came from a non-Stripe source (support-granted,
            // promotional, grandfathered, referral/partner-sponsored — see §46.2's "explicit ledger entries").
            // Confirmed live: telling the latter group "Subscribe to a plan first" is actively wrong and
            // confusing — the screen right above the button already says they're on a paid plan.
            currentPlan === "free"
            ? "Subscribe to a plan first to manage billing."
            : "This plan isn't billed through Stripe, so there's no billing portal to open — contact support if you have questions about it."
          : err instanceof ApiError
            ? err.message
            : "Couldn't open the billing portal. Please try again.",
      );
    } finally {
      setPortalLoading(false);
    }
  }

  const currentPlan = entitlements?.planKey ?? "free";

  return (
    <Screen>
      <ScreenHeader title="Billing" />

      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Current plan</Text>
          <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{PLAN_LABELS[currentPlan]}</Text>
        </View>
        <View style={{ minWidth: 140 }}>
          <Button variant="secondary" onPress={manageBilling} loading={portalLoading}>
            Manage billing
          </Button>
        </View>
      </Card>

      {loadError && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{loadError}</Text>}
      {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}

      {entitlements && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>What&apos;s included</Text>
          <Card style={{ gap: 10 }}>
            {(Object.keys(entitlements.capabilities) as CapabilityKey[]).map((key) => (
              <View key={key} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{CAPABILITY_LABELS[key]}</Text>
                <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{formatCapability(key, entitlements.capabilities[key])}</Text>
              </View>
            ))}
          </Card>
        </View>
      )}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Plans</Text>
        {plansError && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{plansError}</Text>}
        {plans && plans.length === 0 && (
          <Card>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
              Paid plans aren&apos;t available on this deployment yet.
            </Text>
          </Card>
        )}
        {plans &&
          groupPlansByKey(plans).map(({ planKey, options }) => {
            const selectedInterval = intervalByPlan[planKey] ?? (options.month ? "month" : "year");
            const selected = options[selectedInterval] ?? options.month ?? options.year!;
            return (
              <Card key={planKey} style={{ gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{PLAN_LABELS[planKey]}</Text>
                  {currentPlan === planKey ? (
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Current plan</Text>
                  ) : (
                    <View style={{ minWidth: 120 }}>
                      <Button onPress={() => subscribe(selected)} loading={pendingPlan === planKey}>
                        Subscribe
                      </Button>
                    </View>
                  )}
                </View>
                {options.month && options.year && (
                  <View style={{ flexDirection: "row", gap: 6, padding: 4, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}>
                    {(["month", "year"] as const).map((interval) => {
                      const active = selectedInterval === interval;
                      return (
                        <Pressable accessibilityRole="button"
                          key={interval}
                          onPress={() => setIntervalByPlan((prev) => ({ ...prev, [planKey]: interval }))}
                          style={{
                            flex: 1,
                            paddingVertical: 6,
                            borderRadius: theme.radius.sm,
                            backgroundColor: active ? theme.colors.bgSurface : "transparent",
                            alignItems: "center",
                          }}
                        >
                          <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                            {interval === "month" ? "Monthly" : "Annual"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                )}
              </Card>
            );
          })}
      </View>
    </Screen>
  );
}

function groupPlansByKey(plans: PlanOption[]): Array<{ planKey: PlanKey; options: Partial<Record<Interval, PlanOption>> }> {
  const byPlan = new Map<PlanKey, Partial<Record<Interval, PlanOption>>>();
  for (const plan of plans) {
    const options = byPlan.get(plan.planKey) ?? {};
    options[plan.interval] = plan;
    byPlan.set(plan.planKey, options);
  }
  return Array.from(byPlan.entries()).map(([planKey, options]) => ({ planKey, options }));
}
