import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";

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

/** §Account/security "privacy/consent center" (PRIV-001) — mirrors the web /settings/privacy page. */
export default function PrivacyScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [connections, setConnections] = useState<Connection[] | undefined>(undefined);
  const [updatingAi, setUpdatingAi] = useState(false);

  useEffect(() => {
    api.get<Me>("/v1/auth/me").then(setMe);
    api.get<Connection[]>("/v1/connectors").then(setConnections);
  }, []);

  async function toggleAiProcessing(enabled: boolean) {
    setUpdatingAi(true);
    setMe((prev) => (prev ? { ...prev, aiProcessingEnabled: enabled } : prev));
    try {
      await api.post("/v1/auth/ai-processing", { enabled });
    } finally {
      setUpdatingAi(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Privacy" subtitle="What Veynlo can see, what it does with it, and your controls." />

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
          <Switch value={me?.aiProcessingEnabled ?? true} onValueChange={toggleAiProcessing} disabled={updatingAi} />
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>What&apos;s connected</Text>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => router.push("/connections")}>
            Manage →
          </Text>
        </View>
        <Card style={{ gap: 8 }}>
          {!connections && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
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
