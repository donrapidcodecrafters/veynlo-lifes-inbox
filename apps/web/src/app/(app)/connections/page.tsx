"use client";

import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useState } from "react";

interface Connection {
  id: string;
  provider: string;
  health: string;
  healthDetail: string | null;
  lastSuccessfulSyncAt: string | null;
  itemsDiscoveredCount: number;
}

const HEALTH_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  healthy: "positive",
  initializing: "neutral",
  degraded: "warning",
  rate_limited: "neutral",
  reauth_required: "critical",
  permission_reduced: "warning",
  provider_outage: "warning",
  disconnected: "neutral",
};

const AVAILABLE_CONNECTORS = [
  {
    provider: "gmail",
    name: "Gmail",
    description: "Receipts, bills, appointments, and more from your inbox.",
    notConfiguredMessage: "Gmail isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "outlook",
    name: "Outlook",
    description: "The same receipts, bills, and appointments — from a Microsoft 365 or Outlook.com inbox.",
    notConfiguredMessage: "Outlook isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
] as const;

export default function ConnectionsPage() {
  const { data, isLoading, mutate } = useSWR<Connection[]>("/v1/connectors", swrFetcher);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect(provider: (typeof AVAILABLE_CONNECTORS)[number]) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(`/v1/connectors/${provider.provider}/authorize`);
      window.location.href = authorizationUrl;
    } catch (err) {
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? provider.notConfiguredMessage
          : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  async function disconnect(id: string) {
    await api.post(`/v1/connectors/${id}/disconnect`, { deleteDerivedData: false });
    mutate();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Connections</h1>
        <p className="mt-1 text-sm text-tertiary">
          Veynlo only reads what you connect, and you can disconnect or delete it at any time.
        </p>
      </header>

      {connectError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {connectError}
        </p>
      )}

      <div className="space-y-3">
        {AVAILABLE_CONNECTORS.map((provider) => (
          <Card key={provider.provider}>
            <CardBody className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">{provider.name}</p>
                <p className="text-sm text-tertiary">{provider.description}</p>
              </div>
              <Button variant="secondary" onClick={() => connect(provider)}>
                Connect
              </Button>
            </CardBody>
          </Card>
        ))}
      </div>

      {isLoading && <div className="h-20 animate-pulse rounded-xl bg-subtle" />}

      {!isLoading && data && data.length === 0 && (
        <EmptyState title="No connections yet" description="Connect your email above to start finding useful things automatically." />
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((c) => (
            <Card key={c.id}>
              <CardBody className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-[0.9375rem] font-medium capitalize text-primary">{c.provider}</p>
                    <Badge tone={HEALTH_TONE[c.health] ?? "neutral"}>{c.health.replace("_", " ")}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-tertiary">
                    {c.itemsDiscoveredCount} items discovered
                    {c.lastSuccessfulSyncAt && ` · last synced ${new Date(c.lastSuccessfulSyncAt).toLocaleDateString()}`}
                  </p>
                  {c.healthDetail && <p className="mt-1 text-sm text-warning-subtle-text">{c.healthDetail}</p>}
                </div>
                <Button variant="ghost" size="sm" onClick={() => disconnect(c.id)}>
                  Disconnect
                </Button>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
