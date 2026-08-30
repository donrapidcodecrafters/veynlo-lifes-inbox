import { useEffect, useState } from "react";
import { Pressable, Switch as RNSwitch, Text, View } from "react-native";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { ScreenHeader } from "@/components/screen-header";

type PrivacyLevel = "full" | "hide_amounts" | "hide_titles" | "generic";

interface NotificationPreferences {
  intensity: "quiet" | "balanced" | "proactive";
  dailyBriefEnabled: boolean;
  weeklyBriefEnabled: boolean;
  categoryOverrides: Record<string, string>;
  privacyLevel: PrivacyLevel;
}

interface FatigueSuggestion {
  category: string;
  sentCount: number;
  unwantedCount: number;
  unwantedRate: number;
}

// Matches the real `category` values IngestionService.fileInboxItem passes when filing each domain —
// the only categories a user could plausibly want to mute individually. Digests have their own
// dedicated toggles below instead.
const NOTIFICATION_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "purchase", label: "Purchases" },
  { key: "shipment", label: "Shipments" },
  { key: "bill", label: "Bills" },
  { key: "subscription", label: "Subscriptions" },
  { key: "appointment", label: "Appointments" },
  { key: "warranty", label: "Warranties" },
  { key: "task", label: "Tasks" },
];

const INTENSITY_OPTIONS: Array<{ value: NotificationPreferences["intensity"]; label: string }> = [
  { value: "quiet", label: "Quiet" },
  { value: "balanced", label: "Balanced" },
  { value: "proactive", label: "Proactive" },
];

// Cumulative lock-screen privacy ladder — each level hides everything the previous one hides, plus more.
// Matches services/api/src/modules/notifications/notification-privacy.ts's applyPrivacyLevel exactly.
const PRIVACY_LEVEL_OPTIONS: Array<{ value: PrivacyLevel; label: string; description: string }> = [
  { value: "full", label: "Full", description: "Lock screen shows the real title and message." },
  { value: "hide_amounts", label: "Hide amounts", description: "Same as Full, but dollar amounts are hidden." },
  { value: "hide_titles", label: "Hide titles", description: "Hides amounts, and replaces the title with a generic category label." },
  { value: "generic", label: "Generic", description: 'Lock screen shows only "Veynlo" — nothing about what it\'s about.' },
];

export default function NotificationPreferencesScreen() {
  const { theme } = useAppTheme();
  const [prefs, setPrefs] = useState<NotificationPreferences | undefined>(undefined);
  const [fatigueSuggestions, setFatigueSuggestions] = useState<FatigueSuggestion[]>([]);

  useEffect(() => {
    api.get<NotificationPreferences>("/v1/notification-preferences").then(setPrefs);
    api.get<FatigueSuggestion[]>("/v1/notification-preferences/fatigue-suggestions").then(setFatigueSuggestions);
  }, []);

  async function updatePrefs(patch: Partial<NotificationPreferences>) {
    setPrefs((prev) => (prev ? { ...prev, ...patch } : prev));
    await api.put("/v1/notification-preferences", patch);
  }

  function setCategoryMuted(category: string, muted: boolean) {
    const categoryOverrides = { ...(prefs?.categoryOverrides ?? {}) };
    if (muted) categoryOverrides[category] = "off";
    else delete categoryOverrides[category];
    updatePrefs({ categoryOverrides });
    if (muted) setFatigueSuggestions((prev) => prev.filter((s) => s.category !== category));
  }

  if (!prefs) {
    return (
      <Screen>
        <ScreenHeader title="Notification preferences" />
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title="Notification preferences" subtitle="Control how much Veynlo reaches out, and about what." />

      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Intensity</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {INTENSITY_OPTIONS.map((opt) => {
            const active = prefs.intensity === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => updatePrefs({ intensity: opt.value })}
                accessibilityRole="button"
                accessibilityLabel={opt.label}
                accessibilityState={{ selected: active }}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: theme.radius.md,
                  alignItems: "center",
                  backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textOnBrand : theme.colors.textPrimary }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Lock screen privacy</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {PRIVACY_LEVEL_OPTIONS.map((opt) => {
            const active = prefs.privacyLevel === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => updatePrefs({ privacyLevel: opt.value })}
                accessibilityRole="button"
                accessibilityLabel={opt.label}
                accessibilityState={{ selected: active }}
                style={{
                  paddingVertical: 8,
                  paddingHorizontal: 12,
                  borderRadius: theme.radius.md,
                  alignItems: "center",
                  backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textOnBrand : theme.colors.textPrimary }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          {PRIVACY_LEVEL_OPTIONS.find((opt) => opt.value === prefs.privacyLevel)?.description}
        </Text>
      </Card>

      <Card style={{ gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Daily brief</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>A short summary each morning.</Text>
          </View>
          <RNSwitch value={prefs.dailyBriefEnabled} onValueChange={(v) => updatePrefs({ dailyBriefEnabled: v })} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 12 }}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Weekly brief</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>What's coming up next week.</Text>
          </View>
          <RNSwitch value={prefs.weeklyBriefEnabled} onValueChange={(v) => updatePrefs({ weeklyBriefEnabled: v })} />
        </View>
      </Card>

      <Card style={{ gap: 12 }}>
        <View>
          <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>By category</Text>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Turn off notifications for a specific kind of thing without changing your overall intensity.
          </Text>
        </View>
        {fatigueSuggestions.map((s) => {
          const label = NOTIFICATION_CATEGORIES.find((c) => c.key === s.category)?.label ?? s.category;
          return (
            <View
              key={s.category}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                backgroundColor: theme.colors.warningSubtleBg,
                borderRadius: theme.radius.md,
                padding: 12,
              }}
            >
              <Text style={{ flex: 1, fontSize: 13, color: theme.colors.warningSubtleText }}>
                You&apos;ve dismissed {s.unwantedCount} of {s.sentCount} {label.toLowerCase()} notifications recently — mute this category?
              </Text>
              <Text
                onPress={() => setCategoryMuted(s.category, true)}
                accessibilityRole="button"
                style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}
              >
                Mute
              </Text>
            </View>
          );
        })}
        {NOTIFICATION_CATEGORIES.map((c) => (
          <View key={c.key} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>{c.label}</Text>
            <RNSwitch
              value={prefs.categoryOverrides[c.key] !== "off"}
              onValueChange={(v) => setCategoryMuted(c.key, !v)}
            />
          </View>
        ))}
      </Card>
    </Screen>
  );
}
