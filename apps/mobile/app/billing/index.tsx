import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";

type PlanKey = "free" | "plus" | "family" | "pro_agent";
type CapabilityValue = number | boolean | null;

interface EntitlementsResponse {
  planKey: PlanKey;
  capabilities: Record<string, CapabilityValue>;
}

interface PlanOption {
  planKey: PlanKey;
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

  useEffect(() => {
    api.get<EntitlementsResponse>("/v1/billing/entitlements").then(setEntitlements);
    api.get<PlanOption[]>("/v1/billing/plans").then(setPlans);
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
        {plans?.map((plan) => (
          <Card key={plan.planKey} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{PLAN_LABELS[plan.planKey]}</Text>
            {currentPlan === plan.planKey ? (
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Current plan</Text>
            ) : (
              <View style={{ minWidth: 120 }}>
                <Button onPress={() => subscribe(plan)} loading={pendingPlan === plan.planKey}>
                  Subscribe
                </Button>
              </View>
            )}
          </Card>
        ))}
      </View>
    </Screen>
  );
}
