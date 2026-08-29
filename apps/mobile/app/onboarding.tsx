import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";

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
  { value: "90", label: "90d (default)" },
  { value: "30", label: "30d" },
  { value: "0", label: "New only" },
] as const;

export default function OnboardingScreen() {
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [state, setState] = useState<OnboardingState | null | "loading">("loading");
  const [connectError, setConnectError] = useState<string | null>(null);
  const [historyDepthDays, setHistoryDepthDays] = useState<(typeof HISTORY_DEPTH_OPTIONS)[number]["value"]>("90");

  useEffect(() => {
    if (!user) return;
    api
      .get<OnboardingState | null>("/v1/onboarding/state")
      .then((s) => {
        if (!s || s.completedAt || s.skippedAt) {
          router.replace("/(tabs)");
          return;
        }
        setState(s);
      })
      .catch(() => router.replace("/(tabs)"));
  }, [user]);

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
    router.replace("/(tabs)");
  }

  async function finish() {
    await api.post("/v1/onboarding/complete");
    router.replace("/(tabs)");
  }

  async function connect(provider: { provider: string; name: string }) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(
        `/v1/connectors/${provider.provider}/authorize?historyDepthDays=${historyDepthDays}`,
      );
      await Linking.openURL(authorizationUrl);
    } catch (err) {
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? `${provider.name} isn't configured on this deployment yet.`
          : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  if (state === "loading" || !state) return null;

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>Veynlo</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>
          Hi {user?.displayName?.split(" ")[0] ?? "there"} — let's set a few things up.
        </Text>
      </View>

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
    </Screen>
  );
}

function GoalsStep({ onChoose, onSkip }: { onChoose: (goal: OnboardingGoal) => void; onSkip: () => void }) {
  const { theme } = useAppTheme();
  return (
    <Card style={{ gap: 14 }}>
      <View>
        <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary }}>What do you want help with first?</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, marginTop: 4 }}>
          We'll recommend where to start. You can always add more later.
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        {GOALS.map((g) => (
          <Pressable
            key={g.value}
            onPress={() => onChoose(g.value)}
            style={{ borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault, padding: 12 }}
          >
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{g.label}</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>{g.description}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={onSkip}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textTertiary }}>Skip setup for now</Text>
      </Pressable>
    </Card>
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
  const { theme } = useAppTheme();
  const [connections, setConnections] = useState<Connection[]>([]);

  // OAuth completes in the system browser (no in-app deep-link handback on mobile yet — see
  // ROADMAP's connectors item) — so this is how the wizard notices a connection appeared while the
  // user was away in Safari/Chrome and auto-advances instead of leaving them stuck on this screen.
  const checkConnections = useCallback(async () => {
    const data = await api.get<Connection[]>("/v1/connectors").catch(() => []);
    setConnections(data);
    if (data.length > 0) onContinue();
  }, [onContinue]);

  useEffect(() => {
    checkConnections();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") checkConnections();
    });
    return () => sub.remove();
  }, [checkConnections]);

  const recommendedConnectors = recommendedProvider === "calendar" ? CALENDAR_CONNECTORS : recommendedProvider === "email" ? EMAIL_CONNECTORS : [];

  return (
    <Card style={{ gap: 14 }}>
      <View>
        <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary }}>Connect a source</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, marginTop: 4 }}>
          Veynlo only reads what you connect, and you can disconnect or delete it at any time.
        </Text>
      </View>

      {recommendedProvider === "household" && (
        <View style={{ borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSubtle, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Recommended: set up your household</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Invite family members and add dependents.</Text>
          <Button variant="secondary" onPress={() => router.push("/household")}>
            Set up household
          </Button>
        </View>
      )}

      {recommendedConnectors.length > 0 && (
        <View style={{ borderRadius: theme.radius.md, backgroundColor: theme.colors.bgSubtle, padding: 12, gap: 10 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Recommended for you</Text>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {HISTORY_DEPTH_OPTIONS.map((opt) => {
              const active = historyDepthDays === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => onHistoryDepthDaysChange(opt.value)}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    borderRadius: theme.radius.sm,
                    backgroundColor: active ? theme.colors.bgSurface : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {recommendedConnectors.map((c) => (
              <Button key={c.provider} onPress={() => onConnect(c)}>
                {`Connect ${c.name}`}
              </Button>
            ))}
          </View>
        </View>
      )}

      {connectError && <Text style={{ fontSize: 12, color: theme.colors.warningSubtleText }}>{connectError}</Text>}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Or connect anything else:</Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {[...EMAIL_CONNECTORS, ...CALENDAR_CONNECTORS].map((c) => (
            <Button key={c.provider} variant="secondary" onPress={() => onConnect(c)}>
              {c.name}
            </Button>
          ))}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Pressable onPress={onSkip}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textTertiary }}>Skip setup for now</Text>
        </Pressable>
        <Button variant="secondary" onPress={onContinue}>
          Continue
        </Button>
      </View>
    </Card>
  );
}

function ScanningStep({ onContinue }: { onContinue: () => void }) {
  const { theme } = useAppTheme();
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
      if (stillInitializing && attempts < 8) setTimeout(poll, 2500);
    }
    poll();
    return () => {
      cancelled = true;
    };
  }, []);

  const stillInitializing = connections?.some((c) => c.health === "initializing") ?? false;
  const totalItems = connections?.reduce((sum, c) => sum + c.itemsDiscoveredCount, 0) ?? 0;

  return (
    <Card style={{ gap: 14 }}>
      <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary }}>
        {!connections ? "Checking your connections…" : connections.length === 0 ? "Nothing connected yet" : stillInitializing ? "Scanning your connected accounts…" : "Scan complete"}
      </Text>
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        {connections?.length === 0
          ? "That's OK — you can connect a source any time from Connections."
          : stillInitializing
            ? "This usually takes a few seconds. You don't need to wait."
            : `Found ${totalItems} item${totalItems === 1 ? "" : "s"} so far.`}
      </Text>
      <View style={{ alignItems: "flex-end" }}>
        <Button onPress={onContinue}>Continue</Button>
      </View>
    </Card>
  );
}

function SummaryStep({ onFinish }: { onFinish: () => void }) {
  const { theme } = useAppTheme();
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    api
      .get<unknown[]>("/v1/inbox")
      .then((items) => setCount(items.length))
      .catch(() => setCount(0));
  }, []);

  return (
    <Card style={{ gap: 14 }}>
      <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary }}>You're all set</Text>
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        {count === null
          ? "Loading what we've found…"
          : count > 0
            ? `We've already found ${count} thing${count === 1 ? "" : "s"} for your Inbox.`
            : "Nothing's landed yet — that's normal for a brand-new connection. Check back soon."}
      </Text>
      <View style={{ alignItems: "flex-end" }}>
        <Button onPress={onFinish}>Go to Veynlo</Button>
      </View>
    </Card>
  );
}
