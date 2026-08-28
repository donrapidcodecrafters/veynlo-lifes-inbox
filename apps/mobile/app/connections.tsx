import { useCallback, useState } from "react";
import { Linking, RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface Connection {
  id: string;
  provider: string;
  health: string;
  healthDetail: string | null;
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
  { provider: "gmail", name: "Gmail", description: "Receipts, bills, appointments, and more from your inbox." },
  { provider: "outlook", name: "Outlook", description: "The same, from a Microsoft 365 or Outlook.com inbox." },
] as const;

export default function ConnectionsScreen() {
  const { theme } = useAppTheme();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setConnections(await api.get<Connection[]>("/v1/connectors"));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function connect(provider: (typeof AVAILABLE_CONNECTORS)[number]) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(`/v1/connectors/${provider.provider}/authorize`);
      // Completes in the system browser, not an in-app deep-link handback — after finishing there, pull to
      // refresh here (or check the web app) to see the new connection. Real deep-link OAuth handback for
      // native is a follow-up (see ROADMAP).
      await Linking.openURL(authorizationUrl);
    } catch (err) {
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? `${provider.name} isn't configured on this deployment yet.`
          : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  async function disconnect(id: string, deleteDerivedData: boolean) {
    await api.post(`/v1/connectors/${id}/disconnect`, { deleteDerivedData });
    setConfirmingDeleteId(null);
    load();
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Connections" subtitle="Veynlo only reads what you connect, and you can disconnect or delete it at any time." />

      {connectError && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 13 }}>{connectError}</Text>
        </View>
      )}

      <View style={{ gap: 8 }}>
        {AVAILABLE_CONNECTORS.map((provider) => (
          <Card key={provider.provider} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{provider.name}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{provider.description}</Text>
            </View>
            <Button variant="secondary" onPress={() => connect(provider)}>
              Connect
            </Button>
          </Card>
        ))}
      </View>

      {!connections && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {connections?.length === 0 && (
        <EmptyState title="No connections yet" description="Connect your email above to start finding useful things automatically." />
      )}

      {connections && connections.length > 0 && (
        <View style={{ gap: 8 }}>
          {connections.map((c) => (
            <Card key={c.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary, textTransform: "capitalize" }}>
                    {c.provider}
                  </Text>
                  <Badge tone={HEALTH_TONE[c.health] ?? "neutral"}>{c.health.replace(/_/g, " ")}</Badge>
                </View>
                {confirmingDeleteId !== c.id && (
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    <Button variant="ghost" onPress={() => disconnect(c.id, false)}>
                      Disconnect
                    </Button>
                    <Button variant="ghost" onPress={() => setConfirmingDeleteId(c.id)}>
                      Delete data
                    </Button>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{c.itemsDiscoveredCount} items discovered</Text>
              {c.healthDetail && <Text style={{ fontSize: 12, color: theme.colors.warningSubtleText }}>{c.healthDetail}</Text>}
              {confirmingDeleteId === c.id && (
                <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
                    This permanently deletes the purchases, bills, appointments, and other items found via this connection. It
                    can&apos;t be undone.
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button onPress={() => disconnect(c.id, true)}>Confirm delete</Button>
                    <Button variant="ghost" onPress={() => setConfirmingDeleteId(null)}>
                      Cancel
                    </Button>
                  </View>
                </View>
              )}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
