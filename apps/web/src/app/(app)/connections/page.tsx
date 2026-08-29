"use client";

import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label, FieldError } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useEffect, useState, type FormEvent } from "react";

const HISTORY_DEPTH_OPTIONS = [
  { value: "0", label: "New only" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "182", label: "6 months" },
  { value: "365", label: "1 year" },
] as const;

interface InboundAliasInfo {
  configured: boolean;
  address: string | null;
}

// Keyed by the lowercased `code` field of whatever exception the OAuth callback threw — see
// connectors.controller.ts's connectorErrorRedirect.
const CONNECT_ERROR_MESSAGE: Record<string, string> = {
  connector_not_configured: "That connector isn't configured on this deployment yet.",
  invalid_oauth_state: "That connection attempt expired or was invalid. Please try again.",
  connector_failed: "Couldn't complete that connection. Please try again.",
};

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
  const { data: inboundAlias, mutate: mutateInboundAlias } = useSWR<InboundAliasInfo>("/v1/auth/inbound-alias", swrFetcher);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedMessage, setConnectedMessage] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [showIcsForm, setShowIcsForm] = useState(false);
  const [historyDepthDays, setHistoryDepthDays] = useState<(typeof HISTORY_DEPTH_OPTIONS)[number]["value"]>("90");

  // Reads the ?connected=/?error= params the OAuth callback redirects here with (a real browser
  // navigation, not something this page's own JS ever sees mid-flow), then strips them from the URL so a
  // refresh doesn't re-show the same message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) setConnectedMessage(`${PROVIDER_LABEL[connected] ?? connected} connected.`);
    if (error) setConnectError(CONNECT_ERROR_MESSAGE[error] ?? "Couldn't complete that connection. Please try again.");
    if (connected || error) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function connect(provider: (typeof AVAILABLE_CONNECTORS)[number]) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(
        `/v1/connectors/${provider.provider}/authorize?historyDepthDays=${historyDepthDays}`,
      );
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

      {connectedMessage && (
        <p role="status" className="rounded-lg bg-positive-subtle px-3 py-2 text-sm text-positive-subtle-text">
          {connectedMessage}
        </p>
      )}

      {connectError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {connectError}
        </p>
      )}

      <Card>
        <CardBody className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[0.9375rem] font-medium text-primary">History to import</p>
            <p className="text-sm text-tertiary">How far back to look when you connect email or calendar below. Applies going forward too.</p>
          </div>
          <SegmentedControl aria-label="History to import" value={historyDepthDays} onChange={setHistoryDepthDays} options={[...HISTORY_DEPTH_OPTIONS]} />
        </CardBody>
      </Card>

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

        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Forward emails to Veynlo</p>
              <p className="text-sm text-tertiary">
                Forward a receipt, itinerary, or notice to your own Veynlo address — no account access needed.
              </p>
            </div>
            {!inboundAlias && <div className="h-9 w-64 animate-pulse rounded-lg bg-subtle" />}
            {inboundAlias && !inboundAlias.configured && (
              <p className="text-sm text-tertiary">Email forwarding isn&apos;t configured on this deployment yet.</p>
            )}
            {inboundAlias?.configured && inboundAlias.address && (
              <ForwardingAddress address={inboundAlias.address} onRotate={() => mutateInboundAlias()} />
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

function ForwardingAddress({ address, onRotate }: { address: string; onRotate: () => void }) {
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function rotate() {
    setRotating(true);
    try {
      await api.post("/v1/auth/inbound-alias/rotate");
      onRotate();
    } finally {
      setRotating(false);
      setConfirmingRotate(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-lg bg-subtle px-3 py-2 text-sm text-primary">{address}</code>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {!confirmingRotate ? (
        <button type="button" onClick={() => setConfirmingRotate(true)} className="text-sm font-medium text-brand hover:underline">
          Generate a new address
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3">
          <p className="flex-1 text-sm text-warning-subtle-text">
            The current address will stop working immediately. Update anywhere you&apos;ve saved it.
          </p>
          <Button size="sm" onClick={rotate} loading={rotating}>
            Confirm
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingRotate(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
