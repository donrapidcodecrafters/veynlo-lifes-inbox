import { useEffect, useState } from "react";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, Text, View, type ColorValue } from "react-native";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { api } from "@/lib/api-client";

function TabIcon({ label, focused, color }: { label: string; focused: boolean; color: ColorValue }) {
  return (
    // React Navigation's bottom tab bar already gives each tab button its own accessibilityLabel/role/
    // selected-state derived from the screen's `title` (see @react-navigation/bottom-tabs' BottomTabItem),
    // so this emoji glyph is purely decorative chrome next to that spoken label — without hiding it,
    // VoiceOver/TalkBack would announce the raw emoji name ("house emoji") on top of "Home, tab, 1 of 5".
    <Text
      style={{ fontSize: 11, fontWeight: focused ? "700" : "500", color }}
      importantForAccessibility="no"
      accessibilityElementsHidden
      maxFontSizeMultiplier={1.3}
    >
      {label}
    </Text>
  );
}

export default function TabsLayout() {
  const { user, isLoading } = useAuth();
  const { theme } = useAppTheme();
  const { t } = useTranslation("translation", { keyPrefix: "nav" });
  // ONB-001 "after sign-up (or on first sign-in if no onboarding has been completed)" — same resumability
  // check as apps/web's (app) layout: a brand-new account whose onboarding_state row isn't `completed` yet
  // gets bounced to /onboarding from every tab, not just right after sign-up (covers refreshing/relaunching
  // mid-flow, or signing back in later). `needsOnboarding` is false for any pre-existing account with no
  // row at all, so this never retroactively drops an existing user into a first-run flow.
  const [needsOnboarding, setNeedsOnboarding] = useState(false);

  useEffect(() => {
    if (!user) return;
    api
      .get<{ needsOnboarding: boolean }>("/v1/onboarding/state")
      .then((state) => setNeedsOnboarding(state.needsOnboarding))
      .catch(() => {
        // A failed check just means this tab-bar render doesn't redirect — the onboarding screen itself
        // (and the web equivalent) always remains directly reachable and skippable regardless.
      });
  }, [user]);

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.bgCanvas }}>
        <ActivityIndicator color={theme.colors.brandDefault} />
      </View>
    );
  }

  if (!user) return <Redirect href="/sign-in" />;
  if (needsOnboarding) return <Redirect href="/onboarding" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.colors.brandDefault,
        tabBarInactiveTintColor: theme.colors.textTertiary,
        tabBarStyle: { backgroundColor: theme.colors.bgSurface, borderTopColor: theme.colors.borderSubtle },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: t("home"), tabBarIcon: ({ focused, color }) => <TabIcon label="🏠" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="inbox"
        options={{ title: t("inbox"), tabBarIcon: ({ focused, color }) => <TabIcon label="📥" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="ask"
        options={{ title: t("ask"), tabBarIcon: ({ focused, color }) => <TabIcon label="💬" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="life"
        options={{ title: t("life"), tabBarIcon: ({ focused, color }) => <TabIcon label="🗂️" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: t("settings"), tabBarIcon: ({ focused, color }) => <TabIcon label="⚙️" focused={focused} color={color} /> }}
      />
    </Tabs>
  );
}
