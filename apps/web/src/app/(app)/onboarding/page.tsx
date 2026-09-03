"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/input";
import { api, ApiError, swrFetcher } from "@/lib/api-client";

type OnboardingGoal = "important_dates" | "purchases_returns" | "bills_subscriptions" | "family" | "travel" | "things_i_own";
type ConnectorRecommendation = "gmail" | "outlook" | "plaid" | "household" | "manual_asset";
type HistoryDepthChoice = "forward_only" | "days_30" | "days_90" | "months_6" | "year_1" | "build_history";
type OnboardingStep = "goal_selection" | "pre_permission" | "connecting" | "historical_depth" | "scanning" | "discovery_review" | "household_invite" | "completed";

interface OnboardingState {
  needsOnboarding: boolean;
  currentStep: OnboardingStep;
  goal: OnboardingGoal | null;
  recommendedConnector: ConnectorRecommendation | null;
  recommendationReason: string | null;
  historyDepthChoice: HistoryDepthChoice | null;
  allowedHistoryDepthChoices: HistoryDepthChoice[];
  scanConnectionId: string | null;
  householdInviteOfferedAt: string | null;
  completedAt: string | null;
  aiConfigured: boolean;
}

interface ConsentPreview {
  title: string;
  scopes: string[];
  explanation: string;
  notRequested: string[];
}

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  reviewState: string;
}

const GOALS: { key: OnboardingGoal; label: string; blurb: string }[] = [
  { key: "important_dates", label: "Important dates", blurb: "Birthdays, renewals, appointments, deadlines." },
  { key: "purchases_returns", label: "Purchases & returns", blurb: "Receipts, orders, return windows." },
  { key: "bills_subscriptions", label: "Bills & subscriptions", blurb: "Track what's due and what auto-renews." },
  { key: "family", label: "Family", blurb: "Share what matters with your household." },
  { key: "travel", label: "Travel", blurb: "Flights, hotels, and trip confirmations." },
  { key: "things_i_own", label: "Things I own", blurb: "Vehicles, properties, warranties, service." },
];

const DEPTH_OPTIONS: { key: HistoryDepthChoice; label: string; days: number }[] = [
  { key: "forward_only", label: "Forward only", days: 0 },
  { key: "days_30", label: "30 days", days: 30 },
  { key: "days_90", label: "90 days", days: 90 },
  { key: "months_6", label: "6 months", days: 182 },
  { key: "year_1", label: "1 year", days: 365 },
  { key: "build_history", label: "Build my history", days: 3650 },
];

const CONNECT_ERROR_MESSAGE: Record<string, string> = {
  connector_not_configured: "This connector isn't set up on this deployment yet. You can skip this and connect it later from Connections.",
  invalid_oauth_state: "That connection attempt expired. Please try again.",
  connector_failed: "Something went wrong connecting that account. Please try again.",
};

function StepShell({ title, subtitle, children, onSkip }: { title: string; subtitle?: string; children: ReactNode; onSkip?: () => void }) {
  return (
    <Card>
      <CardBody className="space-y-5">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-primary">{title}</h1>
          {subtitle && <p className="text-sm text-secondary">{subtitle}</p>}
        </div>
        {children}
        {onSkip && (
          <div className="border-t border-border-subtle pt-4 text-center">
            <button type="button" onClick={onSkip} className="text-sm font-medium text-tertiary hover:text-secondary hover:underline">
              Skip for now
            </button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const { data: state, mutate, isLoading } = useSWR<OnboardingState>("/v1/onboarding/state", swrFetcher, { revalidateOnFocus: false });
  const [connectError, setConnectError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ONB-001 "an OAuth connect started from onboarding lands back on /onboarding" — pick up the
  // connectionId (or error) the connectors controller's callback put on this URL, then kick off the
  // bounded scan and strip the query string so a refresh doesn't repeat it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connectionId = params.get("connectionId");
    const error = params.get("error");
    if (error) {
      setConnectError(CONNECT_ERROR_MESSAGE[error] ?? "That connection didn't go through. You can try again or skip for now.");
      window.history.replaceState({}, "", "/onboarding");
    } else if (connectionId) {
      api
        .post("/v1/onboarding/scan-start", { connectionId })
        .then(() => mutate())
        .catch(() => setConnectError("Connected, but we couldn't start the scan. You can skip ahead for now."))
        .finally(() => window.history.replaceState({}, "", "/onboarding"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state && !state.needsOnboarding) router.replace("/home");
  }, [state, router]);

  if (isLoading || !state || !state.needsOnboarding) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="size-6 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Loading" />
      </div>
    );
  }

  async function skip() {
    setBusy(true);
    try {
      await api.post("/v1/onboarding/skip");
      // Real bug found live via Playwright: SWR shares one cache per key app-wide (no SWRConfig scoping
      // here), and the (app) layout's own `needsOnboarding` check subscribes to this exact same
      // "/v1/onboarding/state" key — but it doesn't refetch on every navigation, only on mount/focus. Without
      // this `await mutate()`, the layout's copy of the cache still held the pre-skip (`needsOnboarding:
      // true`) response by the time `router.replace("/home")` below ran, so its redirect effect immediately
      // bounced the user straight back to /onboarding — the exact "trap" ONB-001 explicitly rules out.
      // Awaiting the revalidation here (rather than firing it and moving on) guarantees the shared cache is
      // already correct before navigating away.
      await mutate();
      router.replace("/home");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg space-y-4 py-6">
      <ProgressDots step={state.currentStep} />
      {connectError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {connectError}
        </p>
      )}
      {state.currentStep === "goal_selection" && <GoalStep onPicked={() => mutate()} onSkip={skip} busy={busy} setBusy={setBusy} />}
      {state.currentStep === "pre_permission" && <PrePermissionStep state={state} onAdvance={() => mutate()} onSkip={skip} />}
      {state.currentStep === "historical_depth" && <HistoricalDepthStep state={state} onAdvance={() => mutate()} onSkip={skip} />}
      {state.currentStep === "connecting" && (
        <ConnectingStep state={state} onSkip={skip} onError={setConnectError} onNeedsRefresh={() => mutate()} />
      )}
      {state.currentStep === "scanning" && <ScanningStep onAdvance={() => mutate()} />}
      {state.currentStep === "discovery_review" && <DiscoveryReviewStep state={state} onAdvance={() => mutate()} onSkip={skip} />}
      {state.currentStep === "household_invite" && <HouseholdInviteStep onAdvance={() => mutate()} onSkip={skip} />}
    </div>
  );
}

const STEP_ORDER: OnboardingStep[] = [
  "goal_selection",
  "pre_permission",
  "historical_depth",
  "connecting",
  "scanning",
  "discovery_review",
  "household_invite",
];

function ProgressDots({ step }: { step: OnboardingStep }) {
  const index = STEP_ORDER.indexOf(step);
  return (
    <div className="flex justify-center gap-1.5" aria-hidden="true">
      {STEP_ORDER.map((s, i) => (
        <span key={s} className={`h-1.5 w-6 rounded-full ${i <= index ? "bg-brand" : "bg-subtle"}`} />
      ))}
    </div>
  );
}

function GoalStep({
  onPicked,
  onSkip,
  busy,
  setBusy,
}: {
  onPicked: () => void;
  onSkip: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  async function pick(goal: OnboardingGoal) {
    setBusy(true);
    try {
      await api.post("/v1/onboarding/goal", { goal });
      onPicked();
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepShell
      title="What do you most want help with?"
      subtitle="We'll set up one thing based on your answer — you can add more later."
      onSkip={onSkip}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {GOALS.map((g) => (
          <button
            key={g.key}
            type="button"
            disabled={busy}
            onClick={() => pick(g.key)}
            className="rounded-lg border border-border-default bg-surface p-4 text-left transition-colors hover:border-brand hover:bg-brand-subtle disabled:opacity-50"
          >
            <div className="font-medium text-primary">{g.label}</div>
            <div className="mt-0.5 text-sm text-tertiary">{g.blurb}</div>
          </button>
        ))}
      </div>
    </StepShell>
  );
}

const CONNECTOR_LABEL: Record<ConnectorRecommendation, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  plaid: "a bank or card account",
  household: "your household",
  manual_asset: "a vehicle or property",
};

function PrePermissionStep({ state, onAdvance, onSkip }: { state: OnboardingState; onAdvance: () => void; onSkip: () => void }) {
  const connector = state.recommendedConnector;
  const isOAuthConnector = connector === "gmail" || connector === "outlook" || connector === "plaid";
  const { data: preview } = useSWR<ConsentPreview>(
    isOAuthConnector ? `/v1/onboarding/consent-preview?connector=${connector}` : null,
    swrFetcher,
  );
  const [householdName, setHouseholdName] = useState("");
  const [busy, setBusy] = useState(false);

  async function continueToDepth() {
    setBusy(true);
    try {
      await api.post("/v1/onboarding/advance", { step: "historical_depth" });
      onAdvance();
    } finally {
      setBusy(false);
    }
  }

  async function createHousehold(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/v1/households", { name: householdName || "My Household" });
      await api.post("/v1/onboarding/advance", { step: "household_invite" });
      onAdvance();
    } finally {
      setBusy(false);
    }
  }

  async function toThingsIOwn() {
    setBusy(true);
    try {
      await api.post("/v1/onboarding/advance", { step: "household_invite" });
      onAdvance();
    } finally {
      setBusy(false);
    }
  }

  if (connector === "household") {
    return (
      <StepShell title="Set up your household" subtitle={state.recommendationReason ?? undefined} onSkip={onSkip}>
        <form onSubmit={createHousehold} className="space-y-3">
          <div>
            <Label htmlFor="householdName">Household name</Label>
            <Input id="householdName" value={householdName} onChange={(e) => setHouseholdName(e.target.value)} placeholder="My Household" />
          </div>
          <Button type="submit" className="w-full" loading={busy}>
            Create household
          </Button>
        </form>
      </StepShell>
    );
  }

  if (connector === "manual_asset") {
    return (
      <StepShell title="Add what you own" subtitle={state.recommendationReason ?? undefined} onSkip={onSkip}>
        <div className="space-y-3">
          <p className="text-sm text-secondary">
            Add a vehicle or property from the Things I Own section — we'll track warranties, registrations, and service reminders for you.
          </p>
          <Button type="button" className="w-full" onClick={toThingsIOwn} loading={busy}>
            I'll add it now or later
          </Button>
        </div>
      </StepShell>
    );
  }

  return (
    <StepShell
      title={preview?.title ?? `Connect ${connector ? CONNECTOR_LABEL[connector] : "a source"}`}
      subtitle={state.recommendationReason ?? undefined}
      onSkip={onSkip}
    >
      {preview ? (
        <div className="space-y-3">
          <p className="text-sm text-secondary">{preview.explanation}</p>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-tertiary">What we'll access</div>
            <ul className="mt-1 space-y-1">
              {preview.scopes.map((s) => (
                <li key={s} className="text-sm text-primary">
                  <Badge tone="brand">scope</Badge> <span className="ml-1 font-mono text-xs">{s}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-tertiary">We will NOT request</div>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {preview.notRequested.map((n) => (
                <li key={n}>
                  <Badge tone="neutral">{n}</Badge>
                </li>
              ))}
            </ul>
          </div>
          <Button type="button" className="w-full" onClick={continueToDepth} loading={busy}>
            Continue
          </Button>
        </div>
      ) : (
        <div className="h-24 animate-pulse rounded-lg bg-subtle" />
      )}
    </StepShell>
  );
}

function HistoricalDepthStep({ state, onAdvance, onSkip }: { state: OnboardingState; onAdvance: () => void; onSkip: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(choice: HistoryDepthChoice) {
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/onboarding/history-depth", { choice });
      onAdvance();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that choice. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <StepShell
      title="How far back should we look?"
      subtitle="Free plans can look back up to 90 days. Plus unlocks 6 months, 1 year, or your full history."
      onSkip={onSkip}
    >
      <div className="space-y-2">
        {DEPTH_OPTIONS.map((opt) => {
          const allowed = state.allowedHistoryDepthChoices.includes(opt.key);
          return (
            <button
              key={opt.key}
              type="button"
              disabled={busy || !allowed}
              onClick={() => choose(opt.key)}
              className="flex w-full items-center justify-between rounded-lg border border-border-default bg-surface px-4 py-3 text-left transition-colors hover:border-brand hover:bg-brand-subtle disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="font-medium text-primary">{opt.label}</span>
              {!allowed && <Badge tone="brand">Plus+</Badge>}
            </button>
          );
        })}
      </div>
      {error && <p className="mt-2 text-sm text-critical">{error}</p>}
    </StepShell>
  );
}

function ConnectingStep({
  state,
  onSkip,
  onError,
  onNeedsRefresh,
}: {
  state: OnboardingState;
  onSkip: () => void;
  onError: (msg: string) => void;
  onNeedsRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const depthDays = DEPTH_OPTIONS.find((d) => d.key === state.historyDepthChoice)?.days;

  async function connectOAuth(provider: "gmail" | "outlook") {
    setBusy(true);
    try {
      const query = new URLSearchParams({ onboarding: "true" });
      if (depthDays !== undefined) query.set("historyDepthDays", String(depthDays));
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(`/v1/connectors/${provider}/authorize?${query.toString()}`);
      window.location.href = authorizationUrl;
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED") {
        onError(CONNECT_ERROR_MESSAGE.connector_not_configured ?? "This connector isn't set up on this deployment yet.");
      } else {
        onError(err instanceof ApiError ? err.message : "Couldn't start that connection. Please try again.");
      }
    }
  }

  async function connectPlaid() {
    setBusy(true);
    try {
      await api.post("/v1/connectors/plaid/link-token");
      // Plaid Link itself is a client-side widget (see the Connections page for the full embed) — reaching
      // this far already proves Plaid is configured; onboarding hands off to the same Connections flow for
      // the widget/exchange round trip rather than re-implementing it here.
      window.location.href = "/connections?onboarding_plaid=1";
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED") {
        onError(CONNECT_ERROR_MESSAGE.connector_not_configured ?? "This connector isn't set up on this deployment yet.");
      } else {
        onError(err instanceof ApiError ? err.message : "Couldn't start that connection. Please try again.");
      }
    }
  }

  return (
    <StepShell title="Connect your account" subtitle="You can disconnect or delete this at any time from Connections." onSkip={onSkip}>
      <div className="space-y-2">
        {state.recommendedConnector === "plaid" && (
          <Button type="button" className="w-full" onClick={connectPlaid} loading={busy}>
            Connect bank or card account
          </Button>
        )}
        <Button type="button" variant={state.recommendedConnector === "gmail" ? "primary" : "secondary"} className="w-full" onClick={() => connectOAuth("gmail")} loading={busy}>
          Connect Gmail
        </Button>
        <Button
          type="button"
          variant={state.recommendedConnector === "outlook" ? "primary" : "secondary"}
          className="w-full"
          onClick={() => connectOAuth("outlook")}
          loading={busy}
        >
          Connect Outlook
        </Button>
      </div>
      <button
        type="button"
        className="mt-3 text-sm text-tertiary underline"
        onClick={() => {
          onNeedsRefresh();
        }}
      >
        Refresh
      </button>
    </StepShell>
  );
}

function ScanningStep({ onAdvance }: { onAdvance: () => void }) {
  const [discovered, setDiscovered] = useState(0);
  const [status, setStatus] = useState<"scanning" | "complete" | "failed" | "not_started">("scanning");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const progress = await api.get<{ status: "not_started" | "scanning" | "complete" | "failed"; discoveredCount: number }>(
          "/v1/onboarding/scan-progress",
        );
        if (cancelled) return;
        setDiscovered(progress.discoveredCount);
        setStatus(progress.status);
        if (progress.status === "complete" || progress.status === "failed") {
          await api.post("/v1/onboarding/advance", { step: "discovery_review" });
          if (!cancelled) onAdvance();
          return;
        }
      } catch {
        // transient poll failure — just try again on the next tick
      }
      if (!cancelled) timer = setTimeout(poll, 1500);
    }

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <StepShell title="Scanning your inbox…" subtitle="This is a bounded, one-time scan of the window you chose.">
      <div className="flex flex-col items-center gap-4 py-6">
        <div className="size-8 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Scanning" />
        <p className="text-sm text-secondary">
          {status === "scanning" ? `Found ${discovered} item${discovered === 1 ? "" : "s"} so far…` : "Wrapping up…"}
        </p>
      </div>
    </StepShell>
  );
}

function DiscoveryReviewStep({ state, onAdvance, onSkip }: { state: OnboardingState; onAdvance: () => void; onSkip: () => void }) {
  // A brand-new onboarding user's Inbox has nothing in it yet besides this scan's own output, so the
  // existing "new" review-state filter on the shared inbox endpoint IS the scan-scoped view here — no
  // separate discovery-summary endpoint or component needed (see OnboardingService.scanProgress's doc
  // comment on reusing the same real ingestion output rather than a parallel tracker).
  const { data: items, mutate } = useSWR<InboxItem[]>("/v1/inbox?reviewState=new", swrFetcher);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, action: "confirm" | "dismiss") {
    setBusy(id);
    try {
      await api.post(`/v1/inbox/${id}/${action}`);
      await mutate();
    } finally {
      setBusy(null);
    }
  }

  async function continueOn() {
    await api.post("/v1/onboarding/advance", { step: "household_invite" });
    onAdvance();
  }

  const hasItems = (items?.length ?? 0) > 0;

  return (
    <StepShell title="Here's what we found" onSkip={onSkip}>
      {!items ? (
        <div className="h-24 animate-pulse rounded-lg bg-subtle" />
      ) : hasItems ? (
        <div className="space-y-2">
          {items.slice(0, 8).map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle p-3">
              <div className="min-w-0">
                <Badge tone="brand">{item.category}</Badge>
                <p className="mt-1 truncate text-sm text-primary">{item.summary}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" variant="secondary" disabled={busy === item.id} onClick={() => act(item.id, "dismiss")}>
                  Dismiss
                </Button>
                <Button size="sm" disabled={busy === item.id} onClick={() => act(item.id, "confirm")}>
                  Confirm
                </Button>
              </div>
            </div>
          ))}
          <p className="pt-1 text-center text-xs text-tertiary">You can review anything else later from the Inbox.</p>
        </div>
      ) : (
        <EmptyState
          title="Nothing found in this window"
          description={
            state.aiConfigured
              ? "We didn't find anything relevant in the time range you chose. You can widen your history depth later from Connections, or add things manually."
              : "This deployment doesn't have AI extraction configured yet, so scanned messages aren't being categorized. Once it's enabled, a rescan will pick up what's there."
          }
        />
      )}
      <Button type="button" className="mt-4 w-full" onClick={continueOn}>
        Continue
      </Button>
    </StepShell>
  );
}

function HouseholdInviteStep({ onAdvance, onSkip }: { onAdvance: () => void; onSkip: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: households } = useSWR<{ id: string; name: string }[]>("/v1/households", swrFetcher);

  async function finish(offered: boolean) {
    setBusy(true);
    try {
      await api.post("/v1/onboarding/household-invite-offered", { offered });
      await api.post("/v1/onboarding/complete");
      onAdvance();
    } finally {
      setBusy(false);
    }
  }

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const household = households?.[0];
    if (!household) {
      setError("Create a household first from Settings, then invite from there.");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/v1/households/${household.id}/invite`, { email });
      await finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that invite. Please try again.");
      setBusy(false);
    }
  }

  return (
    <StepShell title="Invite a household member?" subtitle="You can always do this later from Settings." onSkip={() => finish(false)}>
      <form onSubmit={sendInvite} className="space-y-3">
        <div>
          <Label htmlFor="inviteEmail">Their email</Label>
          <Input id="inviteEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" required />
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
        <Button type="submit" className="w-full" loading={busy}>
          Send invite
        </Button>
      </form>
    </StepShell>
  );
}
