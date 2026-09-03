import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, Text, View } from "react-native";
import { router, useLocalSearchParams, useRootNavigationState } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { TextField } from "@/components/text-field";

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

export default function OnboardingScreen() {
  const { theme } = useAppTheme();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.get<OnboardingState>("/v1/onboarding/state");
    setState(next);
    setLoaded(true);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoaded(true));
  }, [refresh]);

  useEffect(() => {
    if (loaded && state && !state.needsOnboarding) router.replace("/(tabs)");
  }, [loaded, state]);

  // Mirrors app/connections.tsx's identical deep-link handling: the OAuth callback 302s back to
  // `veynlo://onboarding?connected=<provider>&connectionId=<id>` (or `?error=...`) once a connect started
  // from this screen finishes.
  const rootNavigationState = useRootNavigationState();
  const params = useLocalSearchParams<{ connected?: string; connectionId?: string; error?: string }>();
  useEffect(() => {
    if (!rootNavigationState?.key) return;
    const { connectionId, error } = params;
    if (error) {
      setConnectError(CONNECT_ERROR_MESSAGE[error] ?? "That connection didn't go through. You can try again or skip for now.");
    } else if (connectionId) {
      api
        .post("/v1/onboarding/scan-start", { connectionId })
        .then(() => refresh())
        .catch(() => setConnectError("Connected, but we couldn't start the scan. You can skip ahead for now."));
    }
    if (!connectionId && !error) return;
    const timeoutId = setTimeout(() => router.setParams({ connected: undefined, connectionId: undefined, error: undefined }), 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootNavigationState?.key, params.connectionId, params.error]);

  async function skip() {
    await api.post("/v1/onboarding/skip");
    router.replace("/(tabs)");
  }

  if (!loaded || !state || !state.needsOnboarding) {
    return (
      <Screen contentContainerStyle={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <View />
      </Screen>
    );
  }

  return (
    <Screen>
      <ProgressDots step={state.currentStep} />
      {connectError && (
        <Card style={{ backgroundColor: theme.colors.warningSubtleBg, borderColor: theme.colors.warningSubtleBg }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 14 }}>{connectError}</Text>
        </Card>
      )}
      {state.currentStep === "goal_selection" && <GoalStep onPicked={refresh} onSkip={skip} />}
      {state.currentStep === "pre_permission" && <PrePermissionStep state={state} onAdvance={refresh} onSkip={skip} />}
      {state.currentStep === "historical_depth" && <HistoricalDepthStep state={state} onAdvance={refresh} onSkip={skip} />}
      {state.currentStep === "connecting" && <ConnectingStep state={state} onSkip={skip} onError={setConnectError} />}
      {state.currentStep === "scanning" && <ScanningStep onAdvance={refresh} />}
      {state.currentStep === "discovery_review" && <DiscoveryReviewStep state={state} onAdvance={refresh} onSkip={skip} />}
      {state.currentStep === "household_invite" && <HouseholdInviteStep onAdvance={refresh} onSkip={skip} />}
    </Screen>
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
  const { theme } = useAppTheme();
  const index = STEP_ORDER.indexOf(step);
  return (
    <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
      {STEP_ORDER.map((s, i) => (
        <View
          key={s}
          style={{ width: 24, height: 6, borderRadius: 3, backgroundColor: i <= index ? theme.colors.brandDefault : theme.colors.bgSubtle }}
        />
      ))}
    </View>
  );
}

function SkipLink({ onSkip }: { onSkip: () => void }) {
  const { theme } = useAppTheme();
  return (
    <Text accessibilityRole="button" onPress={onSkip} style={{ textAlign: "center", color: theme.colors.textTertiary, fontSize: 14, fontWeight: "600", paddingTop: 8 }}>
      Skip for now
    </Text>
  );
}

function GoalStep({ onPicked, onSkip }: { onPicked: () => void; onSkip: () => void }) {
  const { theme } = useAppTheme();
  const [busy, setBusy] = useState(false);

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
    <Card style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>What do you most want help with?</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>We'll set up one thing based on your answer.</Text>
      </View>
      <View style={{ gap: 8 }}>
        {GOALS.map((g) => (
          <Button key={g.key} variant="secondary" disabled={busy} onPress={() => pick(g.key)}>
            {g.label}
          </Button>
        ))}
      </View>
      <SkipLink onSkip={onSkip} />
    </Card>
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
  const { theme } = useAppTheme();
  const connector = state.recommendedConnector;
  const isOAuthConnector = connector === "gmail" || connector === "outlook" || connector === "plaid";
  const [preview, setPreview] = useState<ConsentPreview | null>(null);
  const [householdName, setHouseholdName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOAuthConnector || !connector) return;
    api.get<ConsentPreview>(`/v1/onboarding/consent-preview?connector=${connector}`).then(setPreview);
  }, [isOAuthConnector, connector]);

  async function continueToDepth() {
    setBusy(true);
    try {
      await api.post("/v1/onboarding/advance", { step: "historical_depth" });
      onAdvance();
    } finally {
      setBusy(false);
    }
  }

  async function createHousehold() {
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
      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>Set up your household</Text>
        {state.recommendationReason && <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>{state.recommendationReason}</Text>}
        <TextField label="Household name" value={householdName} onChangeText={setHouseholdName} placeholder="My Household" />
        <Button onPress={createHousehold} loading={busy}>
          Create household
        </Button>
        <SkipLink onSkip={onSkip} />
      </Card>
    );
  }

  if (connector === "manual_asset") {
    return (
      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>Add what you own</Text>
        {state.recommendationReason && <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>{state.recommendationReason}</Text>}
        <Button onPress={toThingsIOwn} loading={busy}>
          I'll add it now or later
        </Button>
        <SkipLink onSkip={onSkip} />
      </Card>
    );
  }

  return (
    <Card style={{ gap: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>
        {preview?.title ?? `Connect ${connector ? CONNECTOR_LABEL[connector] : "a source"}`}
      </Text>
      {state.recommendationReason && <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>{state.recommendationReason}</Text>}
      {preview ? (
        <View style={{ gap: 10 }}>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>{preview.explanation}</Text>
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>What we'll access</Text>
            {preview.scopes.map((s) => (
              <Badge key={s} tone="brand">
                {s}
              </Badge>
            ))}
          </View>
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
              We will NOT request
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {preview.notRequested.map((n) => (
                <Badge key={n}>{n}</Badge>
              ))}
            </View>
          </View>
          <Button onPress={continueToDepth} loading={busy}>
            Continue
          </Button>
        </View>
      ) : (
        <Text style={{ color: theme.colors.textTertiary }}>Loading…</Text>
      )}
      <SkipLink onSkip={onSkip} />
    </Card>
  );
}

function HistoricalDepthStep({ state, onAdvance, onSkip }: { state: OnboardingState; onAdvance: () => void; onSkip: () => void }) {
  const { theme } = useAppTheme();
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
    <Card style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>How far back should we look?</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
          Free plans can look back up to 90 days. Plus unlocks 6 months, 1 year, or your full history.
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        {DEPTH_OPTIONS.map((opt) => {
          const allowed = state.allowedHistoryDepthChoices.includes(opt.key);
          return (
            <View key={opt.key} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" disabled={busy || !allowed} onPress={() => choose(opt.key)}>
                  {opt.label}
                </Button>
              </View>
              {!allowed && <Badge tone="brand">Plus+</Badge>}
            </View>
          );
        })}
      </View>
      {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
      <SkipLink onSkip={onSkip} />
    </Card>
  );
}

function ConnectingStep({ state, onSkip, onError }: { state: OnboardingState; onSkip: () => void; onError: (msg: string) => void }) {
  const { theme } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const depthDays = DEPTH_OPTIONS.find((d) => d.key === state.historyDepthChoice)?.days;

  async function connectOAuth(provider: "gmail" | "outlook") {
    setBusy(true);
    // Same synchronous-popup trick as app/connections.tsx's connect() — required under expo-web so the
    // browser doesn't silently block the tab once the `await` below breaks transient click activation.
    const isWeb = Platform.OS === "web" && typeof window !== "undefined";
    const popupWindow = isWeb ? window.open("", "_blank") : null;
    if (isWeb && !popupWindow) {
      setBusy(false);
      onError("Your browser blocked the pop-up window for this connection. Please allow pop-ups for this site and try again.");
      return;
    }
    try {
      const query = new URLSearchParams({ onboarding: "true" });
      if (depthDays !== undefined) query.set("historyDepthDays", String(depthDays));
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(`/v1/connectors/${provider}/authorize?${query.toString()}`);
      if (popupWindow) popupWindow.location.href = authorizationUrl;
      else await Linking.openURL(authorizationUrl);
    } catch (err) {
      popupWindow?.close();
      onError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? (CONNECT_ERROR_MESSAGE.connector_not_configured ?? "This connector isn't set up on this deployment yet.")
          : "Couldn't start that connection. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>Connect your account</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>You can disconnect this at any time from Connections.</Text>
      </View>
      <View style={{ gap: 8 }}>
        <Button variant={state.recommendedConnector === "gmail" ? "primary" : "secondary"} disabled={busy} onPress={() => connectOAuth("gmail")}>
          Connect Gmail
        </Button>
        <Button variant={state.recommendedConnector === "outlook" ? "primary" : "secondary"} disabled={busy} onPress={() => connectOAuth("outlook")}>
          Connect Outlook
        </Button>
      </View>
      <SkipLink onSkip={onSkip} />
    </Card>
  );
}

function ScanningStep({ onAdvance }: { onAdvance: () => void }) {
  const { theme } = useAppTheme();
  const [discovered, setDiscovered] = useState(0);

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
        if (progress.status === "complete" || progress.status === "failed") {
          await api.post("/v1/onboarding/advance", { step: "discovery_review" });
          if (!cancelled) onAdvance();
          return;
        }
      } catch {
        // transient poll failure — retry on next tick
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
    <Card style={{ gap: 12, alignItems: "center", paddingVertical: 32 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>Scanning your inbox…</Text>
      <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>Found {discovered} item{discovered === 1 ? "" : "s"} so far…</Text>
    </Card>
  );
}

function DiscoveryReviewStep({ state, onAdvance, onSkip }: { state: OnboardingState; onAdvance: () => void; onSkip: () => void }) {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(await api.get<InboxItem[]>("/v1/inbox?reviewState=new"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(id: string, action: "confirm" | "dismiss") {
    setBusy(id);
    try {
      await api.post(`/v1/inbox/${id}/${action}`);
      await load();
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
    <Card style={{ gap: 12 }}>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>Here's what we found</Text>
      {!items ? (
        <Text style={{ color: theme.colors.textTertiary }}>Loading…</Text>
      ) : hasItems ? (
        <View style={{ gap: 8 }}>
          {items.slice(0, 8).map((item) => (
            <View key={item.id} style={{ borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.md, padding: 12, gap: 6 }}>
              <Badge tone="brand">{item.category}</Badge>
              <Text style={{ fontSize: 14, color: theme.colors.textPrimary }} numberOfLines={2}>
                {item.summary}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button variant="secondary" disabled={busy === item.id} onPress={() => act(item.id, "dismiss")}>
                    Dismiss
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button disabled={busy === item.id} onPress={() => act(item.id, "confirm")}>
                    Confirm
                  </Button>
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : (
        <EmptyState
          title="Nothing found in this window"
          description={
            state.aiConfigured
              ? "We didn't find anything relevant in the time range you chose. You can widen your history depth later, or add things manually."
              : "This deployment doesn't have AI extraction configured yet, so scanned messages aren't being categorized."
          }
        />
      )}
      <Button onPress={continueOn}>Continue</Button>
      <SkipLink onSkip={onSkip} />
    </Card>
  );
}

function HouseholdInviteStep({ onAdvance, onSkip }: { onAdvance: () => void; onSkip: () => void }) {
  const { theme } = useAppTheme();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [households, setHouseholds] = useState<{ id: string; name: string }[] | null>(null);

  useEffect(() => {
    api.get<{ id: string; name: string }[]>("/v1/households").then(setHouseholds);
  }, []);

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

  async function sendInvite() {
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
    <Card style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>Invite a household member?</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>You can always do this later from Settings.</Text>
      </View>
      <TextField label="Their email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
      {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}
      <Button onPress={sendInvite} loading={busy}>
        Send invite
      </Button>
      <SkipLink onSkip={() => finish(false)} />
    </Card>
  );
}
