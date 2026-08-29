import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  lastActiveAt: string | null;
  platform: string | null;
  displayName: string | null;
  isCurrent: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web browser",
  ios: "iPhone/iPad",
  android: "Android",
  macos: "macOS app",
  windows: "Windows app",
  extension: "Browser extension",
};

export default function SessionsScreen() {
  const { theme } = useAppTheme();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSessions(await api.get<SessionRow[]>("/v1/auth/sessions"));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/auth/sessions/${id}/revoke`);
      await load();
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Devices & sessions" subtitle="Everywhere you're currently signed in to Veynlo." />
      <Card style={{ gap: 10 }}>
        {!sessions && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
        {sessions?.map((s) => (
          <View key={s.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                  {s.displayName ?? PLATFORM_LABEL[s.platform ?? ""] ?? s.platform ?? "Unknown device"}
                </Text>
                {s.isCurrent && <Badge tone="positive">This device</Badge>}
              </View>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Signed in {new Date(s.createdAt).toLocaleDateString()} · last active{" "}
                {s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleDateString() : new Date(s.lastSeenAt).toLocaleDateString()}
              </Text>
            </View>
            {!s.isCurrent && (
              <Button variant="ghost" onPress={() => revoke(s.id)} loading={revokingId === s.id}>
                Sign out
              </Button>
            )}
          </View>
        ))}
      </Card>
    </Screen>
  );
}
