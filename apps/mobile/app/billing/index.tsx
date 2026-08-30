import { useEffect, useState } from "react";
import { Linking, Platform, Pressable, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";
import { purchasePlan, PurchaseCancelledError, PurchasesNotAvailableError } from "@/lib/purchases";

type PlanKey = "free" | "plus" | "family" | "pro_agent";
type CapabilityValue = number | boolean | null;
type Interval = "month" | "year";

interface EntitlementsResponse {
  planKey: PlanKey;
  capabilities: Record<string, CapabilityValue>;
  entitlements: Array<{ source: string }>;
}

// App Store/Play Store policy requires digital subscriptions to go through native IAP, not a web
// checkout — apps/web's Stripe checkout-session flow is only reachable here on Platform.OS === "web"
// (Expo's browser preview target); a real iOS/Android build always takes the native purchase path.
const useNativePurchases = Platform.OS !== "web";

interface PlanOption {
  planKey: PlanKey;
  interval: Interval;
  priceId: string;
  capabilities: Record<string, CapabilityValue>;
}

const PLAN_LABELS: Record<PlanKey, string> = {
  free: "Free",
  plus: "Plus",
  family: "Family",
  pro_agent: "Pro Agent",
};

export default function BillingScreen() {
  const { theme } = useAppTheme();
  const [entitlements, setEntitlements] = useState<EntitlementsResponse | undefined>(undefined);
  const [plans, setPlans] = useState<PlanOption[] | undefined>(undefined);
  const [pendingPlan, setPendingPlan] = useState<PlanKey | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intervalByPlan, setIntervalByPlan] = useState<Partial<Record<PlanKey, Interval>>>({});

  useEffect(() => {
    api.get<EntitlementsResponse>("/v1/billing/entitlements").then(setEntitlements);
    api.get<PlanOption[]>("/v1/billing/plans").then(setPlans);
  }, []);

  async function subscribe(plan: PlanOption) {
    setError(null);
    setPendingPlan(plan.planKey);
    try {
      if (useNativePurchases) {
        await purchasePlan(plan.planKey, plan.interval);
        // The entitlement grant itself happens async via the RevenueCat webhook — this refresh is
        // best-effort (it may still show the old plan for a few seconds), same timing gap the Stripe
        // checkout redirect flow below already has.
        setEntitlements(await api.get<EntitlementsResponse>("/v1/billing/entitlements"));
      } else {
        const { url } = await api.post<{ url: string }>("/v1/billing/checkout-session", {
          planKey: plan.planKey,
          priceId: plan.priceId,
        });
        await Linking.openURL(url);
      }
    } catch (err) {
      if (err instanceof PurchaseCancelledError) {
        // User backed out of the native purchase sheet — not an error worth surfacing.
      } else if (err instanceof PurchasesNotAvailableError) {
        setError(err.message);
      } else {
        setError(err instanceof ApiError ? err.message : "Couldn't complete the purchase. Please try again.");
      }
    } finally {
      setPendingPlan(null);
    }
  }

  async function manageBilling() {
    setError(null);
    // A RevenueCat-sourced subscription has no Stripe customer to open a portal session for — Apple/
    // Google both require subscription management to go through their own native settings surface.
    const activeSource = entitlements?.entitlements[0]?.source;
    if (useNativePurchases && activeSource === "revenuecat") {
      const url =
        Platform.OS === "ios"
          ? "itms-apps://apps.apple.com/account/subscriptions"
          : "https://play.google.com/store/account/subscriptions";
      await Linking.openURL(url).catch(() => setError("Couldn't open subscription settings."));
      return;
    }
    setPortalLoading(true);
    try {
      const { url } = await api.post<{ url: string }>("/v1/billing/portal-session");
      await Linking.openURL(url);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "NO_BILLING_ACCOUNT"
          ? "Subscribe to a plan first to manage billing."
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

      {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Plans</Text>
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
                        <Pressable
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
