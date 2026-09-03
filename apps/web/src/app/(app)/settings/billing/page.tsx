"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { CapabilityKey, CapabilityValue, PlanKey } from "@veynlo/core";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { FetchError } from "@/components/ui/fetch-error";

interface EntitlementsResponse {
  planKey: PlanKey;
  capabilities: Record<CapabilityKey, CapabilityValue>;
}

interface PlanOption {
  planKey: PlanKey;
  interval: "month" | "year";
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

function groupPlansByKey(plans: PlanOption[]): Array<{ planKey: PlanKey; options: Partial<Record<"month" | "year", PlanOption>> }> {
  const byPlan = new Map<PlanKey, Partial<Record<"month" | "year", PlanOption>>>();
  for (const plan of plans) {
    const options = byPlan.get(plan.planKey) ?? {};
    options[plan.interval] = plan;
    byPlan.set(plan.planKey, options);
  }
  return Array.from(byPlan.entries()).map(([planKey, options]) => ({ planKey, options }));
}

function formatCapability(key: CapabilityKey, value: CapabilityValue): string {
  if (typeof value === "boolean") return value ? "Included" : "Not included";
  if (value === null) return "Unlimited";
  if (key === "document_storage_mb") return value >= 1000 ? `${(value / 1000).toFixed(0)} GB` : `${value} MB`;
  if (key === "historical_backfill_days") return `${value} days`;
  return String(value);
}

export default function BillingPage() {
  const { data: entitlements, error: entitlementsError, mutate: mutateEntitlements } = useSWR<EntitlementsResponse>("/v1/billing/entitlements", swrFetcher);
  const { data: plans, error: plansError, mutate: mutatePlans } = useSWR<PlanOption[]>("/v1/billing/plans", swrFetcher);
  const [pendingPlan, setPendingPlan] = useState<PlanKey | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [intervalByPlan, setIntervalByPlan] = useState<Partial<Record<PlanKey, "month" | "year">>>({});

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

  // Found live: while entitlements was still loading, `?? "free"` made every visitor — including paid
  // subscribers — see "Current plan: Free" flash before the real plan loaded in, since undefined and "no
  // paid plan" were indistinguishable here. Only fall back to "free" once entitlements has actually
  // loaded and said so.
  const currentPlan = entitlements ? entitlements.planKey : null;

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
            {currentPlan ? (
              <p className="text-[0.9375rem] font-medium text-primary">{PLAN_LABELS[currentPlan]}</p>
            ) : entitlementsError ? (
              <p className="mt-1 text-sm text-critical">Couldn&apos;t load</p>
            ) : (
              <div className="mt-1 h-5 w-20 animate-pulse rounded bg-subtle" />
            )}
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

      {/* Bug fix: found live via a forced 500 on GET /v1/billing/entitlements — with no `error` handling
          here at all, `entitlements` just stayed undefined forever, so "What's included" silently never
          rendered (its own `{entitlements && ...}` guard hid it) and the "Current plan" pulse above kept
          animating indefinitely with no indication anything had gone wrong. */}
      {entitlementsError && !entitlements && (
        <FetchError what="what's included in your plan" message={entitlementsError instanceof ApiError ? entitlementsError.message : undefined} onRetry={() => mutateEntitlements()} />
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
        {/* Same gap as entitlements above, for GET /v1/billing/plans — "Plans" would otherwise render as
            a bare heading with nothing underneath and no error on a fetch failure. */}
        {plansError && !plans && (
          <FetchError what="the available plans" message={plansError instanceof ApiError ? plansError.message : undefined} onRetry={() => mutatePlans()} />
        )}
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
            {groupPlansByKey(plans).map(({ planKey, options }) => {
              const selectedInterval = intervalByPlan[planKey] ?? (options.month ? "month" : "year");
              const selected = options[selectedInterval] ?? options.month ?? options.year!;
              return (
                <Card key={planKey}>
                  <CardBody className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-[0.9375rem] font-medium text-primary">{PLAN_LABELS[planKey]}</p>
                      {options.month && options.year && (
                        <SegmentedControl
                          aria-label={`${PLAN_LABELS[planKey]} billing interval`}
                          value={selectedInterval}
                          onChange={(v) => setIntervalByPlan((prev) => ({ ...prev, [planKey]: v }))}
                          options={[
                            { value: "month", label: "Monthly" },
                            { value: "year", label: "Annual" },
                          ]}
                        />
                      )}
                    </div>
                    {currentPlan === planKey ? (
                      <span className="text-sm text-tertiary">Current plan</span>
                    ) : (
                      <Button onClick={() => subscribe(selected)} loading={pendingPlan === planKey}>
                        Subscribe
                      </Button>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
