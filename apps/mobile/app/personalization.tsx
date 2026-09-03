import { useCallback, useEffect, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { CATEGORY_DOMAIN_KEYS, type CategoryDomainKey } from "@veynlo/core";
import { api } from "@/lib/api-client";
import { usePersonalizationPreferences } from "@/lib/use-personalization";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

// PERS-002 "Home customization" — mirrors apps/web's identical constants (see (tabs)/index.tsx's own
// OPTIONAL_MODULE_KEYS doc comment).
const OPTIONAL_MODULE_KEYS = ["today", "money_at_risk", "family_today"] as const;
type OptionalModuleKey = (typeof OPTIONAL_MODULE_KEYS)[number];
const MODULE_LABELS: Record<OptionalModuleKey, string> = {
  today: "Today",
  money_at_risk: "Money at risk & savings",
  family_today: "Household — Today",
};

interface HomeModulePreferences {
  moduleOrder: string[];
  hiddenModules: string[];
}

function resolveModuleOrder(prefs: HomeModulePreferences | null): OptionalModuleKey[] {
  const stored = (prefs?.moduleOrder ?? []).filter((k): k is OptionalModuleKey => (OPTIONAL_MODULE_KEYS as readonly string[]).includes(k));
  const missing = OPTIONAL_MODULE_KEYS.filter((k) => !stored.includes(k));
  return [...stored, ...missing];
}

interface CategoryPreference {
  domain: CategoryDomainKey;
  label: string;
  disableExplanation: string;
  enabled: boolean;
}

/**
 * PERS-002/003/004/005 — mirrors apps/web's /settings/personalization page. Home layout reorder/hide,
 * per-category opt-out, preferred name/week-start/time-format, and Ask's answer-style/suggestion-intensity
 * preference, all in one screen since none of these had ANY mobile settings surface before this.
 */
export default function PersonalizationScreen() {
  const { theme } = useAppTheme();
  const [modulePrefs, setModulePrefs] = useState<HomeModulePreferences | null>(null);
  const [categoryPrefs, setCategoryPrefs] = useState<CategoryPreference[] | null>(null);
  const { data: personalization, update: updatePersonalization } = usePersonalizationPreferences();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const load = useCallback(() => {
    api.get<HomeModulePreferences>("/v1/home-module-preferences").then(setModulePrefs).catch(() => {});
    api.get<CategoryPreference[]>("/v1/category-preferences").then(setCategoryPrefs).catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const moduleOrder = resolveModuleOrder(modulePrefs);
  const hiddenModules = new Set(modulePrefs?.hiddenModules ?? []);

  async function saveHomeModulePreferences(nextOrder: OptionalModuleKey[], nextHidden: Set<string>) {
    setModulePrefs({ moduleOrder: nextOrder, hiddenModules: [...nextHidden] });
    await api.put("/v1/home-module-preferences", { moduleOrder: nextOrder, hiddenModules: [...nextHidden] });
  }

  function moveModule(key: OptionalModuleKey, direction: -1 | 1) {
    const index = moduleOrder.indexOf(key);
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= moduleOrder.length) return;
    const next = [...moduleOrder];
    [next[index], next[swapWith]] = [next[swapWith]!, next[index]!];
    saveHomeModulePreferences(next, hiddenModules);
  }

  function toggleModuleHidden(key: OptionalModuleKey, hidden: boolean) {
    const next = new Set(hiddenModules);
    if (hidden) next.add(key);
    else next.delete(key);
    saveHomeModulePreferences(moduleOrder, next);
  }

  async function toggleCategory(domain: CategoryDomainKey, enabled: boolean) {
    setCategoryPrefs((prev) => prev?.map((c) => (c.domain === domain ? { ...c, enabled } : c)) ?? null);
    await api.put("/v1/category-preferences", { domain, enabled });
  }

  async function saveName() {
    setSavingName(true);
    try {
      await updatePersonalization({ preferredName: nameDraft });
      setNameDraft(null);
    } finally {
      setSavingName(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Personalization" subtitle="Home layout, what Veynlo pays attention to, your preferred name, and how Ask responds." />

      {/* PERS-002 Home customization */}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Home layout</Text>
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, marginBottom: 6 }}>
            Reorder or hide the sections below Needs You. Needs You always stays first and can&apos;t be hidden.
          </Text>
          {moduleOrder.map((key, index) => (
            <View
              key={key}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                paddingVertical: 10,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: theme.colors.borderDefault,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1 }}>
                <View style={{ gap: 2 }}>
                  <Pressable
                    disabled={index === 0}
                    onPress={() => moveModule(key, -1)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${MODULE_LABELS[key]} up`}
                    accessibilityState={{ disabled: index === 0 }}
                  >
                    <Text style={{ color: index === 0 ? theme.colors.borderDefault : theme.colors.textTertiary, fontSize: 12 }}>▲</Text>
                  </Pressable>
                  <Pressable
                    disabled={index === moduleOrder.length - 1}
                    onPress={() => moveModule(key, 1)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Move ${MODULE_LABELS[key]} down`}
                    accessibilityState={{ disabled: index === moduleOrder.length - 1 }}
                  >
                    <Text style={{ color: index === moduleOrder.length - 1 ? theme.colors.borderDefault : theme.colors.textTertiary, fontSize: 12 }}>▼</Text>
                  </Pressable>
                </View>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{MODULE_LABELS[key]}</Text>
              </View>
              <Switch
                value={!hiddenModules.has(key)}
                onValueChange={(shown) => toggleModuleHidden(key, !shown)}
                accessibilityLabel={`Show ${MODULE_LABELS[key]} on Home`}
                trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
              />
            </View>
          ))}
        </Card>
      </View>

      {/* PERS-003 Category preferences */}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>What Veynlo pays attention to</Text>
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, marginBottom: 6 }}>
            Turn off a category to stop Veynlo from detecting new items in it. Anything already saved stays exactly as it is.
          </Text>
          {(categoryPrefs ?? CATEGORY_DOMAIN_KEYS.map((domain) => ({ domain, label: domain, disableExplanation: "", enabled: true }))).map((cat, index) => (
            <View key={cat.domain} style={{ paddingVertical: 10, borderTopWidth: index === 0 ? 0 : 1, borderTopColor: theme.colors.borderDefault, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{cat.label}</Text>
                <Switch
                  value={cat.enabled}
                  onValueChange={(enabled) => toggleCategory(cat.domain, enabled)}
                  accessibilityLabel={cat.label}
                  trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                  {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
                />
              </View>
              {!cat.enabled && cat.disableExplanation ? <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{cat.disableExplanation}</Text> : null}
            </View>
          ))}
        </Card>
      </View>

      {/* PERS-004 Naming and language */}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Naming and language</Text>
        <Card style={{ gap: 12 }}>
          <TextField
            label="Preferred name"
            placeholder="What should Veynlo call you?"
            value={nameDraft ?? personalization.preferredName ?? ""}
            onChangeText={setNameDraft}
          />
          <Button variant="secondary" onPress={saveName} loading={savingName} disabled={nameDraft === null}>
            Save
          </Button>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Object nicknames (e.g. renaming &quot;2015 Honda Civic&quot; to &quot;Mom&apos;s car&quot;) are set from that item&apos;s own page —
            vehicles, property, and pets each have their own editable label.
          </Text>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 12 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Week starts on</Text>
            <View style={{ flexDirection: "row", gap: 6, padding: 4, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}>
              {(["sunday", "monday"] as const).map((opt) => (
                <Pressable
                  key={opt}
                  onPress={() => updatePersonalization({ weekStart: opt })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: personalization.weekStart === opt }}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    borderRadius: theme.radius.sm,
                    backgroundColor: personalization.weekStart === opt ? theme.colors.bgSurface : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: personalization.weekStart === opt ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                    {opt === "sunday" ? "Sunday" : "Monday"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 12 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Time format</Text>
            <View style={{ flexDirection: "row", gap: 6, padding: 4, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}>
              {(["12h", "24h"] as const).map((opt) => (
                <Pressable
                  key={opt}
                  onPress={() => updatePersonalization({ timeFormat: opt })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: personalization.timeFormat === opt }}
                  style={{
                    paddingVertical: 6,
                    paddingHorizontal: 10,
                    borderRadius: theme.radius.sm,
                    backgroundColor: personalization.timeFormat === opt ? theme.colors.bgSurface : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: personalization.timeFormat === opt ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                    {opt === "12h" ? "12-hour" : "24-hour"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Card>
      </View>

      {/* PERS-005 AI tone/verbosity */}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Ask</Text>
        <Card style={{ gap: 12 }}>
          <View style={{ gap: 6 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Answer style</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Never changes what Ask is willing to say or how sure it is.</Text>
            <View style={{ flexDirection: "row", gap: 6, padding: 4, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}>
              {(["concise", "balanced", "detailed"] as const).map((opt) => (
                <Pressable
                  key={opt}
                  onPress={() => updatePersonalization({ askResponseStyle: opt })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: personalization.askResponseStyle === opt }}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    borderRadius: theme.radius.sm,
                    alignItems: "center",
                    backgroundColor: personalization.askResponseStyle === opt ? theme.colors.bgSurface : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: personalization.askResponseStyle === opt ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                    {opt[0]!.toUpperCase() + opt.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 12 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Proactive suggestions</Text>
            <View style={{ flexDirection: "row", gap: 6, padding: 4, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}>
              {(["quiet", "balanced", "proactive"] as const).map((opt) => (
                <Pressable
                  key={opt}
                  onPress={() => updatePersonalization({ suggestionIntensity: opt })}
                  accessibilityRole="button"
                  accessibilityState={{ selected: personalization.suggestionIntensity === opt }}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    borderRadius: theme.radius.sm,
                    alignItems: "center",
                    backgroundColor: personalization.suggestionIntensity === opt ? theme.colors.bgSurface : "transparent",
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: personalization.suggestionIntensity === opt ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                    {opt[0]!.toUpperCase() + opt.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Card>
      </View>
    </Screen>
  );
}
