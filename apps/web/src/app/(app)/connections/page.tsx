"use client";

import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, FieldError } from "@/components/ui/input";
import { useState, type FormEvent } from "react";

interface Connection {
  id: string;
  provider: string;
  health: string;
  healthDetail: string | null;
  lastSuccessfulSyncAt: string | null;
  itemsDiscoveredCount: number;
}

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
};

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
  {
    provider: "google-calendar",
    name: "Google Calendar",
    description: "Sync your Google Calendar events directly — separate from Gmail, so you can connect either on its own.",
    notConfiguredMessage: "Google Calendar isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "microsoft-calendar",
    name: "Microsoft Calendar",
    description: "Sync your Outlook/Microsoft 365 calendar events directly — separate from Outlook mail.",
    notConfiguredMessage: "Microsoft Calendar isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
] as const;

export default function ConnectionsPage() {
  const { data, isLoading, mutate } = useSWR<Connection[]>("/v1/connectors", swrFetcher);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [showIcsForm, setShowIcsForm] = useState(false);

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

  async function disconnect(id: string, deleteDerivedData: boolean) {
    await api.post(`/v1/connectors/${id}/disconnect`, { deleteDerivedData });
    setConfirmingDeleteId(null);
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

        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Calendar feed (ICS)</p>
                <p className="text-sm text-tertiary">Subscribe to a school, team, or shared calendar's .ics link — events sync automatically.</p>
              </div>
              {!showIcsForm && (
                <Button variant="secondary" onClick={() => setShowIcsForm(true)}>
                  Add feed
                </Button>
              )}
            </div>
            {showIcsForm && (
              <IcsConnectForm
                onDone={() => {
                  setShowIcsForm(false);
                  mutate();
                }}
                onCancel={() => setShowIcsForm(false)}
              />
            )}
          </CardBody>
        </Card>
      </div>

      {isLoading && <div className="h-20 animate-pulse rounded-xl bg-subtle" />}

      {!isLoading && data && data.length === 0 && (
        <EmptyState title="No connections yet" description="Connect your email above to start finding useful things automatically." />
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((c) => (
            <Card key={c.id}>
              <CardBody className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-[0.9375rem] font-medium text-primary">{PROVIDER_LABEL[c.provider] ?? c.provider}</p>
                      <Badge tone={HEALTH_TONE[c.health] ?? "neutral"}>{c.health.replace("_", " ")}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-tertiary">
                      {c.itemsDiscoveredCount} items discovered
                      {c.lastSuccessfulSyncAt && ` · last synced ${new Date(c.lastSuccessfulSyncAt).toLocaleDateString()}`}
                    </p>
                    {c.healthDetail && <p className="mt-1 text-sm text-warning-subtle-text">{c.healthDetail}</p>}
                  </div>
                  {confirmingDeleteId !== c.id && (
                    <div className="flex shrink-0 gap-2">
                      <Button variant="ghost" size="sm" onClick={() => disconnect(c.id, false)}>
                        Disconnect
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(c.id)}>
                        Disconnect &amp; delete data
                      </Button>
                    </div>
                  )}
                </div>
                {confirmingDeleteId === c.id && (
                  <div className="space-y-3 rounded-lg border border-critical/40 bg-critical-subtle p-3">
                    <p className="text-sm text-critical-subtle-text">
                      This permanently deletes the purchases, bills, appointments, and other items found via this connection. It
                      can&apos;t be undone.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => disconnect(c.id, true)}>
                        Confirm delete
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function IcsConnectForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [basicAuthUsername, setBasicAuthUsername] = useState("");
  const [basicAuthPassword, setBasicAuthPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/connectors/ics/connect", {
        url,
        feedName: feedName || undefined,
        basicAuthUsername: showAuth && basicAuthUsername ? basicAuthUsername : undefined,
        basicAuthPassword: showAuth && basicAuthPassword ? basicAuthPassword : undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-border-subtle bg-subtle p-3" noValidate>
      <div>
        <Label htmlFor="ics-url">Calendar feed URL</Label>
        <Input
          id="ics-url"
          type="url"
          placeholder="https://example.com/calendar.ics"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="ics-name">Name (optional)</Label>
        <Input id="ics-name" value={feedName} onChange={(e) => setFeedName(e.target.value)} placeholder="e.g. Kid's soccer schedule" />
      </div>
      {!showAuth ? (
        <button type="button" onClick={() => setShowAuth(true)} className="text-sm font-medium text-brand hover:underline">
          This feed needs a username and password
        </button>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ics-user">Username</Label>
            <Input id="ics-user" value={basicAuthUsername} onChange={(e) => setBasicAuthUsername(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="ics-pass">Password</Label>
            <Input
              id="ics-pass"
              type="password"
              value={basicAuthPassword}
              onChange={(e) => setBasicAuthPassword(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
      )}
      <FieldError>{error ?? undefined}</FieldError>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting} disabled={!url}>
          Add feed
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
