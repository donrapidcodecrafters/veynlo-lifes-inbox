"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/use-session";
import { api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";

type OnboardingGoal = "important_dates" | "purchases_returns" | "bills_subscriptions" | "family" | "travel" | "things_i_own";
type OnboardingStep = "goals" | "connect" | "scanning" | "summary";
type Recommendation = "email" | "calendar" | "household" | null;

interface OnboardingState {
  goal: OnboardingGoal | null;
  step: OnboardingStep;
  recommendedProvider: Recommendation;
  completedAt: string | null;
  skippedAt: string | null;
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  itemsDiscoveredCount: number;
}

const GOALS: Array<{ value: OnboardingGoal; label: string; description: string }> = [
  { value: "important_dates", label: "Important dates", description: "Appointments, deadlines, and events you can't miss." },
  { value: "purchases_returns", label: "Purchases & returns", description: "Order confirmations, return windows, and warranties." },
  { value: "bills_subscriptions", label: "Bills & subscriptions", description: "What's due, what renews, and when." },
  { value: "family", label: "Family", description: "Share what matters with the people in your household." },
  { value: "travel", label: "Travel", description: "Itineraries, confirmations, and trip details in one place." },
  { value: "things_i_own", label: "Things I own", description: "Receipts, manuals, and warranties for what you've bought." },
];

const EMAIL_CONNECTORS = [
  { provider: "gmail", name: "Gmail" },
  { provider: "outlook", name: "Outlook" },
] as const;

const CALENDAR_CONNECTORS = [
  { provider: "google-calendar", name: "Google Calendar" },
  { provider: "microsoft-calendar", name: "Microsoft Calendar" },
] as const;

const HISTORY_DEPTH_OPTIONS = [
  { value: "0", label: "New only" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "182", label: "6 months" },
  { value: "365", label: "1 year" },
] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const { user, isLoading: sessionLoading, isAuthenticated } = useSession();
  const [state, setState] = useState<OnboardingState | null | "loading">("loading");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [historyDepthDays, setHistoryDepthDays] = useState<(typeof HISTORY_DEPTH_OPTIONS)[number]["value"]>("90");

  useEffect(() => {
    if (sessionLoading) return;
    if (!isAuthenticated) {
      router.replace("/sign-in");
      return;
    }
    api
      .get<OnboardingState | null>("/v1/onboarding/state")
      .then((s) => {
        if (!s || s.completedAt || s.skippedAt) {
          router.replace("/home");
          return;
        }
        setState(s);
      })
      .catch(() => router.replace("/home"));
  }, [sessionLoading, isAuthenticated, router]);

  async function chooseGoal(goal: OnboardingGoal) {
    const updated = await api.patch<OnboardingState>("/v1/onboarding/state", { goal, step: "connect" });
    setState(updated);
  }

  async function advanceTo(step: OnboardingStep) {
    const updated = await api.patch<OnboardingState>("/v1/onboarding/state", { step });
    setState(updated);
  }

  async function skip() {
    await api.post("/v1/onboarding/skip");
    router.replace("/home");
  }

  async function finish() {
    await api.post("/v1/onboarding/complete");
    router.replace("/home");
  }

  async function connect(provider: { provider: string; name: string }) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(
        `/v1/connectors/${provider.provider}/authorize?historyDepthDays=${historyDepthDays}`,
      );
      window.location.href = authorizationUrl;
    } catch (err) {
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? `${provider.name} isn't configured on this deployment yet.`
          : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  if (state === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="size-6 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Loading" />
      </div>
    );
  }
  if (!state) return null;

  return (
    <div className="flex min-h-dvh items-start justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[640px]">
        <div className="mb-8 text-center">
          <span className="text-xl font-semibold tracking-tight text-primary">Veynlo</span>
          <p className="mt-1 text-sm text-tertiary">Hi {user?.displayName?.split(" ")[0] ?? "there"} — let's set a few things up.</p>
        </div>

        {state.step === "goals" && <GoalsStep onChoose={chooseGoal} onSkip={skip} />}

        {state.step === "connect" && (
          <ConnectStep
            recommendedProvider={state.recommendedProvider}
            historyDepthDays={historyDepthDays}
            onHistoryDepthDaysChange={setHistoryDepthDays}
            connectError={connectError}
            onConnect={connect}
            onContinue={() => advanceTo("scanning")}
            onSkip={skip}
          />
        )}

        {state.step === "scanning" && <ScanningStep onContinue={() => advanceTo("summary")} />}

        {state.step === "summary" && <SummaryStep onFinish={finish} />}
      </div>
    </div>
  );
}

function StepCard({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardBody className="space-y-5">{children}</CardBody>
    </Card>
  );
}

function GoalsStep({ onChoose, onSkip }: { onChoose: (goal: OnboardingGoal) => void; onSkip: () => void }) {
  return (
    <StepCard>
      <div>
        <h1 className="text-lg font-semibold text-primary">What do you want help with first?</h1>
        <p className="mt-1 text-sm text-tertiary">We'll recommend where to start based on your answer. You can always add more later.</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {GOALS.map((g) => (
          <button
            key={g.value}
            type="button"
            onClick={() => onChoose(g.value)}
            className="rounded-lg border border-border-default bg-surface p-3 text-left transition-colors hover:border-brand hover:bg-subtle"
          >
            <p className="text-[0.9375rem] font-medium text-primary">{g.label}</p>
            <p className="mt-0.5 text-sm text-tertiary">{g.description}</p>
          </button>
        ))}
      </div>
      <button type="button" onClick={onSkip} className="text-sm font-medium text-tertiary hover:text-secondary hover:underline">
        Skip setup for now
      </button>
    </StepCard>
  );
}

function ConnectStep({
  recommendedProvider,
  historyDepthDays,
  onHistoryDepthDaysChange,
  connectError,
  onConnect,
  onContinue,
  onSkip,
}: {
  recommendedProvider: Recommendation;
  historyDepthDays: (typeof HISTORY_DEPTH_OPTIONS)[number]["value"];
  onHistoryDepthDaysChange: (v: (typeof HISTORY_DEPTH_OPTIONS)[number]["value"]) => void;
  connectError: string | null;
  onConnect: (provider: { provider: string; name: string }) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const recommendedConnectors = recommendedProvider === "calendar" ? CALENDAR_CONNECTORS : recommendedProvider === "email" ? EMAIL_CONNECTORS : [];

  return (
    <StepCard>
      <div>
        <h1 className="text-lg font-semibold text-primary">Connect a source</h1>
        <p className="mt-1 text-sm text-tertiary">
          Veynlo only reads what you connect, and you can disconnect or delete it at any time. Nothing is shared with anyone else.
        </p>
      </div>

      {recommendedProvider === "household" && (
        <div className="rounded-lg border border-brand/40 bg-subtle p-3">
          <p className="text-[0.9375rem] font-medium text-primary">Recommended: set up your household</p>
          <p className="mt-0.5 text-sm text-tertiary">Invite family members and add dependents so everyone's important things live in one place.</p>
          <a href="/household" className="mt-2 inline-block">
            <Button size="sm">Set up household</Button>
          </a>
        </div>
      )}

      {recommendedConnectors.length > 0 && (
        <div className="space-y-3 rounded-lg border border-brand/40 bg-subtle p-3">
          <div className="flex items-center justify-between gap-4">
            <p className="text-[0.9375rem] font-medium text-primary">Recommended for you</p>
            <SegmentedControl
              aria-label="History to import"
              value={historyDepthDays}
              onChange={onHistoryDepthDaysChange}
              options={[...HISTORY_DEPTH_OPTIONS]}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {recommendedConnectors.map((c) => (
              <Button key={c.provider} size="sm" onClick={() => onConnect(c)}>
                Connect {c.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {connectError && <p className="text-sm text-warning-subtle-text">{connectError}</p>}

      <div className="space-y-2 border-t border-border-subtle pt-4">
        <p className="text-sm text-tertiary">Or connect anything else:</p>
        <div className="flex flex-wrap gap-2">
          {[...EMAIL_CONNECTORS, ...CALENDAR_CONNECTORS].map((c) => (
            <Button key={c.provider} size="sm" variant="secondary" onClick={() => onConnect(c)}>
              {c.name}
            </Button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border-subtle pt-4">
        <button type="button" onClick={onSkip} className="text-sm font-medium text-tertiary hover:text-secondary hover:underline">
          Skip setup for now
        </button>
        <Button variant="secondary" size="sm" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </StepCard>
  );
}

function ScanningStep({ onContinue }: { onContinue: () => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    async function poll() {
      const data = await api.get<Connection[]>("/v1/connectors").catch(() => []);
      if (cancelled) return;
      setConnections(data);
      attempts += 1;
      const stillInitializing = data.some((c) => c.health === "initializing");
      if (stillInitializing && attempts < 8) {
        setTimeout(poll, 2500);
      }
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  const stillInitializing = connections?.some((c) => c.health === "initializing") ?? false;
  const totalItems = connections?.reduce((sum, c) => sum + c.itemsDiscoveredCount, 0) ?? 0;

  return (
    <StepCard>
      <div className="flex items-center gap-3">
        {stillInitializing && <div className="size-5 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-hidden />}
        <div>
          <h1 className="text-lg font-semibold text-primary">
            {!connections ? "Checking your connections…" : connections.length === 0 ? "Nothing connected yet" : stillInitializing ? "Scanning your connected accounts…" : "Scan complete"}
          </h1>
          <p className="mt-1 text-sm text-tertiary">
            {connections?.length === 0
              ? "That's OK — you can connect a source any time from Connections."
              : stillInitializing
                ? "This usually takes a few seconds. You don't need to wait — we'll keep going in the background."
                : `Found ${totalItems} item${totalItems === 1 ? "" : "s"} so far.`}
          </p>
        </div>
      </div>
      <div className="flex justify-end border-t border-border-subtle pt-4">
        <Button size="sm" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </StepCard>
  );
}

function SummaryStep({ onFinish }: { onFinish: () => void }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    api
      .get<{ items: unknown[]; nextCursor: string | null }>("/v1/inbox")
      .then((res) => setCount(res.items.length))
      .catch(() => setCount(0));
  }, []);

  return (
    <StepCard>
      <div>
        <h1 className="text-lg font-semibold text-primary">You're all set</h1>
        <p className="mt-1 text-sm text-tertiary">
          {count === null
            ? "Loading what we've found…"
            : count > 0
              ? `We've already found ${count} thing${count === 1 ? "" : "s"} for your Inbox.`
              : "Nothing's landed yet — that's normal for a brand-new connection. Check back soon, or connect more sources any time."}
        </p>
      </div>
      <div className="flex justify-end border-t border-border-subtle pt-4">
        <Button size="sm" onClick={onFinish}>
          Go to Veynlo
        </Button>
      </div>
    </StepCard>
  );
}
