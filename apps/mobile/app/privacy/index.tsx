import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { usePersonalizationPreferences } from "@/lib/use-personalization";
import { useFinancialPrivacy } from "@/lib/financial-privacy-context";

interface Me {
  id: string;
  email: string | null;
  aiProcessingEnabled: boolean;
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  lastSuccessfulSyncAt: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
};

/**
 * FIN-007 "Allow amounts and account names to be hidden on Home, widgets, household surfaces and
 * notifications... Mask by default on lock screen; biometric reveal option." The toggle persists across
 * devices; "Reveal" is a per-session step-up (Face ID/Touch ID first, via BiometricLockContext, falling
 * back to a password prompt on a device with no biometrics set up) that never touches the stored
 * preference — leaving this screen always starts masked again next time.
 */
function FinancialPrivacySection() {
  const { theme } = useAppTheme();
  const { data, update } = usePersonalizationPreferences();
  const { masked, revealed, requestReveal, hide } = useFinancialPrivacy();
  const [updating, setUpdating] = useState(false);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  async function toggleEnabled(enabled: boolean) {
    setUpdating(true);
    try {
      await update({ financialPrivacyModeEnabled: enabled });
    } finally {
      setUpdating(false);
    }
  }

  async function reveal(withPassword?: string) {
    setRevealBusy(true);
    setRevealError(null);
    try {
      const result = await requestReveal(withPassword);
      if (result.ok) {
        setPasswordPromptOpen(false);
        setPassword("");
        return;
      }
      if (result.needsPassword) {
        setPasswordPromptOpen(true);
        return;
      }
      setRevealError(result.error ?? "Couldn't verify — try again.");
    } finally {
      setRevealBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Financial privacy</Text>
      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Financial privacy mode</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
            Mask dollar amounts and account names on Home, widgets, and notifications until you confirm it&apos;s you.
          </Text>
        </View>
        <Switch
          value={data.financialPrivacyModeEnabled}
          onValueChange={toggleEnabled}
          disabled={updating}
          accessibilityLabel="Financial privacy mode"
          trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
          {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
        />
      </Card>
      {data.financialPrivacyModeEnabled && (
        <Card style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary, flex: 1 }}>
              {masked ? "Amounts are currently hidden on this device." : "Amounts are revealed for this session."}
            </Text>
            {masked && !passwordPromptOpen && (
              <Button variant="secondary" onPress={() => reveal()} loading={revealBusy}>
                Reveal
              </Button>
            )}
            {revealed && (
              <Button variant="ghost" onPress={hide}>
                Hide again
              </Button>
            )}
          </View>
          {passwordPromptOpen && (
            <View style={{ gap: 8 }}>
              <TextField label="Confirm your password to reveal amounts" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} autoFocus />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button onPress={() => reveal(password)} loading={revealBusy}>
                  Unlock
                </Button>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setPasswordPromptOpen(false);
                    setPassword("");
                  }}
                >
                  Cancel
                </Button>
              </View>
            </View>
          )}
          {revealError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{revealError}</Text>}
        </Card>
      )}
    </View>
  );
}

/** §Account/security "privacy/consent center" (PRIV-001) — mirrors the web /settings/privacy page. */
export default function PrivacyScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [connections, setConnections] = useState<Connection[] | undefined>(undefined);
  const [updatingAi, setUpdatingAi] = useState(false);
  // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx): a `.then` with no `.catch` on a
  // mount-time fetch becomes an unhandled promise rejection on any transient network failure, which React
  // Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just
  // this screen.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Me>("/v1/auth/me")
      .then(setMe)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your privacy settings. Please try again."));
    api
      .get<Connection[]>("/v1/connectors")
      .then(setConnections)
      // A fetch failure here must not be presented as "you have nothing connected" — that's a distinct,
      // misleading state from a genuinely empty list, so it gets its own inline error instead of being
      // silently coerced into `[]`.
      .catch((err) => setConnectionsError(err instanceof ApiError ? err.message : "Couldn't load your connections. Please try again."));
  }, []);

  async function toggleAiProcessing(enabled: boolean) {
    setUpdatingAi(true);
    setAiError(null);
    const previous = me;
    setMe((prev) => (prev ? { ...prev, aiProcessingEnabled: enabled } : prev));
    try {
      await api.post("/v1/auth/ai-processing", { enabled });
    } catch (err) {
      setMe(previous); // roll back the optimistic update — the server didn't actually apply it
      setAiError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setUpdatingAi(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Privacy" subtitle="What Veynlo can see, what it does with it, and your controls." />
      {loadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{loadError}</Text>}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>AI processing</Text>
        <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
              Let Veynlo use AI to understand what&apos;s captured
            </Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
              Off stops all AI classification/extraction — new items are filed as-is.
            </Text>
          </View>
          {/* `activeThumbColor` (RNW-only, not in RN's typed SwitchProps — harmlessly ignored on native)
              keeps the web preview's ON-state thumb on-brand: `trackColor` alone left the track purple
              but the thumb defaulting to react-native-web's hardcoded teal, confirmed live. */}
          <Switch
            value={me?.aiProcessingEnabled ?? true}
            onValueChange={toggleAiProcessing}
            disabled={updatingAi}
            accessibilityLabel="Let Veynlo use AI to understand what's captured"
            trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
            {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
          />
        </Card>
        {aiError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{aiError}</Text>}
      </View>

      <FinancialPrivacySection />

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>What&apos;s connected</Text>
          <Text accessibilityRole="button" style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => router.push("/connections")}>
            Manage →
          </Text>
        </View>
        <Card style={{ gap: 8 }}>
          {!connections && !connectionsError && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
          {connectionsError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{connectionsError}</Text>}
          {connections?.length === 0 && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Nothing connected yet — Veynlo only reads what you connect.</Text>
          )}
          {connections?.map((c) => (
            <View key={c.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{PROVIDER_LABEL[c.provider] ?? c.provider}</Text>
              <Badge tone={c.health === "healthy" ? "positive" : c.health === "disconnected" ? "neutral" : "warning"}>
                {c.health.replace(/_/g, " ")}
              </Badge>
            </View>
          ))}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Your data</Text>
        <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Export your data</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Download a copy of everything Veynlo has recorded for you.</Text>
          </View>
          <View style={{ minWidth: 100 }}>
            <Button variant="secondary" onPress={() => router.push("/data-export")}>
              Export
            </Button>
          </View>
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Delete your account</Text>
        <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Permanently delete your account</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>This can&apos;t be undone. Handled from Settings.</Text>
          </View>
          <View style={{ minWidth: 100 }}>
            <Button variant="critical" onPress={() => router.push("/(tabs)/settings")}>
              Settings
            </Button>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
