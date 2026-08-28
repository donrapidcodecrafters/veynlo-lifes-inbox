"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { CapabilityKey, CapabilityValue, PlanKey } from "@veynlo/core";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface EntitlementsResponse {
  planKey: PlanKey;
  capabilities: Record<CapabilityKey, CapabilityValue>;
}

interface PlanOption {
  planKey: PlanKey;
  priceId: string;
  capabilities: Record<CapabilityKey, CapabilityValue>;
}

const PLAN_LABELS: Record<PlanKey, string> = {
  free: "Free",
  plus: "Plus",
  family: "Family",
  pro_agent: "Pro Agent",
};

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  email_connections_max: "Email connections",
  calendar_connections_max: "Calendar connections",
  historical_backfill_days: "History backfill",
  ask_queries_per_day: "Ask queries per day",
  document_storage_mb: "Document storage",
  purchases_returns_tracking: "Purchase & return tracking",
  subscriptions_bills_tracking: "Subscription & bill tracking",
  financial_aggregator_connections_max: "Bank connections",
  home_vehicle_profiles: "Home & vehicle profiles",
  family_school_sharing: "Family & school sharing",
  automation_rules_max: "Automation rules",
  emergency_binder: "Emergency binder",
  data_export: "Data export",
  desktop_power_tools: "Desktop power tools",
  household_members_max: "Household members",
};

function formatCapability(key: CapabilityKey, value: CapabilityValue): string {
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  if (value === null) return "Unlimited";
  if (key === "document_storage_mb") return value >= 1000 ? `${(value / 1000).toFixed(0)} GB` : `${value} MB`;
  if (key === "historical_backfill_days") return `${value} days`;
  return String(value);
}

export default function BillingPage() {
  const { data: entitlements } = useSWR<EntitlementsResponse>("/v1/billing/entitlements", swrFetcher);
  const { data: plans } = useSWR<PlanOption[]>("/v1/billing/plans", swrFetcher);
  const [pendingPlan, setPendingPlan] = useState<PlanKey | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function subscribe(plan: PlanOption) {
    setError(null);
    setPendingPlan(plan.planKey);
    try {
      const { url } = await api.post<{ url: string }>("/v1/billing/checkout-session", {
        planKey: plan.planKey,
        priceId: plan.priceId,
      });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start checkout. Please try again.");
      setPendingPlan(null);
    }
  }

  async function manageBilling() {
    setError(null);
    setPortalLoading(true);
    try {
      const { url } = await api.post<{ url: string }>("/v1/billing/portal-session");
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "NO_BILLING_ACCOUNT"
          ? "Subscribe to a plan first to manage billing."
          : err instanceof ApiError
            ? err.message
            : "Couldn't open the billing portal. Please try again.",
      );
      setPortalLoading(false);
    }
  }

  const currentPlan = entitlements?.planKey ?? "free";

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Billing</h1>
      </header>

      <Card>
        <CardBody className="flex items-center justify-between">
          <div>
            <p className="text-sm text-tertiary">Current plan</p>
            <p className="text-[0.9375rem] font-medium text-primary">{PLAN_LABELS[currentPlan]}</p>
          </div>
          <Button variant="secondary" onClick={manageBilling} loading={portalLoading}>
            Manage billing
          </Button>
        </CardBody>
      </Card>

      {error && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {error}
        </p>
      )}

      {entitlements && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
            What&apos;s included
          </h2>
          <Card>
            <CardBody className="space-y-3">
              {(Object.keys(entitlements.capabilities) as CapabilityKey[]).map((key) => (
                <div key={key} className="flex items-center justify-between">
                  <p className="text-sm text-primary">{CAPABILITY_LABELS[key]}</p>
                  <p className="text-sm text-tertiary">{formatCapability(key, entitlements.capabilities[key])}</p>
                </div>
              ))}
            </CardBody>
          </Card>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Plans</h2>
        {plans && plans.length === 0 && (
          <Card>
            <CardBody>
              <p className="text-sm text-tertiary">
                Paid plans aren&apos;t available on this deployment yet.
              </p>
            </CardBody>
          </Card>
        )}
        {plans && plans.length > 0 && (
          <div className="space-y-3">
            {plans.map((plan) => (
              <Card key={plan.planKey}>
                <CardBody className="flex items-center justify-between">
                  <p className="text-[0.9375rem] font-medium text-primary">{PLAN_LABELS[plan.planKey]}</p>
                  {currentPlan === plan.planKey ? (
                    <span className="text-sm text-tertiary">Current plan</span>
                  ) : (
                    <Button onClick={() => subscribe(plan)} loading={pendingPlan === plan.planKey}>
                      Subscribe
                    </Button>
                  )}
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
