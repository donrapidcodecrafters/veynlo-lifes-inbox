import { useCallback, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
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
  disabledMailCategories: string[];
  dataRetentionDays: number | null;
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  lastSuccessfulSyncAt: string | null;
}

interface SenderRule {
  id: string;
  senderAddress: string;
  action: "block" | "category_override";
  categoryOverride: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
  google_tasks: "Google Tasks",
  microsoft_todo: "Microsoft To Do",
};

const MAIL_CATEGORIES = [
  { value: "receipt", label: "Receipts" },
  { value: "shipment", label: "Shipments" },
  { value: "bill", label: "Bills" },
  { value: "subscription", label: "Subscriptions" },
  { value: "calendar_event", label: "Calendar events" },
  { value: "travel", label: "Travel" },
  { value: "warranty", label: "Warranties" },
] as const;

const RETENTION_OPTIONS = [
  { value: null, label: "Forever" },
  { value: 90, label: "90d" },
  { value: 180, label: "180d" },
  { value: 365, label: "1yr" },
  { value: 730, label: "2yr" },
] as const;

/** §Account/security "privacy/consent center" (PRIV-001) — mirrors the web /settings/privacy page. */
export default function PrivacyScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [connections, setConnections] = useState<Connection[] | undefined>(undefined);
  const [senderRules, setSenderRules] = useState<SenderRule[] | undefined>(undefined);
  const [updatingAi, setUpdatingAi] = useState(false);
  const [updatingCategories, setUpdatingCategories] = useState(false);
  const [updatingRetention, setUpdatingRetention] = useState(false);
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<Me>("/v1/auth/me").then(setMe);
    api.get<Connection[]>("/v1/connectors").then(setConnections);
    api.get<SenderRule[]>("/v1/inbox/sender-rules").then(setSenderRules);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function toggleAiProcessing(enabled: boolean) {
    setUpdatingAi(true);
    setMe((prev) => (prev ? { ...prev, aiProcessingEnabled: enabled } : prev));
    try {
      await api.post("/v1/auth/ai-processing", { enabled });
    } finally {
      setUpdatingAi(false);
    }
  }

  async function toggleCategory(category: string, disabled: boolean) {
    if (!me) return;
    const next = disabled ? [...me.disabledMailCategories, category] : me.disabledMailCategories.filter((c) => c !== category);
    setUpdatingCategories(true);
    setMe((prev) => (prev ? { ...prev, disabledMailCategories: next } : prev));
    try {
      await api.post("/v1/auth/disabled-mail-categories", { categories: next });
    } finally {
      setUpdatingCategories(false);
    }
  }

  async function setRetention(days: number | null) {
    setUpdatingRetention(true);
    setMe((prev) => (prev ? { ...prev, dataRetentionDays: days } : prev));
    try {
      await api.post("/v1/auth/data-retention", { days });
    } finally {
      setUpdatingRetention(false);
    }
  }

  async function removeSenderRule(ruleId: string) {
    setRemovingRuleId(ruleId);
    try {
      await api.post(`/v1/inbox/sender-rules/${ruleId}/delete`);
      setSenderRules((prev) => prev?.filter((r) => r.id !== ruleId));
    } finally {
      setRemovingRuleId(null);
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
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Mail categories</Text>
        <Card style={{ gap: 10 }}>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Turn off any category you&apos;d rather Veynlo never extract from your mail at all.
          </Text>
          {MAIL_CATEGORIES.map((cat) => {
            const disabled = me?.disabledMailCategories.includes(cat.value) ?? false;
            return (
              <View key={cat.value} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{cat.label}</Text>
                <Switch value={!disabled} onValueChange={(enabled) => toggleCategory(cat.value, !enabled)} disabled={updatingCategories} />
              </View>
            );
          })}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Blocked senders</Text>
        <Card style={{ gap: 8 }}>
          {!senderRules && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
          {senderRules?.length === 0 && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
              No sender rules yet — block a sender from any Inbox item to stop it from being processed at all.
            </Text>
          )}
          {senderRules?.map((rule) => (
            <View key={rule.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }} numberOfLines={1}>
                {rule.senderAddress}
              </Text>
              <Badge tone={rule.action === "block" ? "critical" : "neutral"}>
                {rule.action === "block" ? "Blocked" : `Always: ${rule.categoryOverride}`}
              </Badge>
              <Button variant="ghost" loading={removingRuleId === rule.id} onPress={() => removeSenderRule(rule.id)}>
                Remove
              </Button>
            </View>
          ))}
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
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Raw evidence retention</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            How long to keep the original captured email content once it&apos;s processed. Anything already extracted is kept regardless.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {RETENTION_OPTIONS.map((opt) => {
              const active = (me?.dataRetentionDays ?? null) === opt.value;
              return (
                <Text
                  key={opt.label}
                  onPress={() => !updatingRetention && setRetention(opt.value)}
                  style={{
                    fontSize: 13,
                    fontWeight: "600",
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                    borderRadius: theme.radius.full,
                    backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                    color: active ? theme.colors.textOnBrand : theme.colors.textSecondary,
                    overflow: "hidden",
                  }}
                >
                  {opt.label}
                </Text>
              );
            })}
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
