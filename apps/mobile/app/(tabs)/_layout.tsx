import { useEffect, useState } from "react";
import { Redirect, Tabs, router } from "expo-router";
import { ActivityIndicator, Text, View, type ColorValue } from "react-native";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { api } from "@/lib/api-client";

function TabIcon({ label, focused, color }: { label: string; focused: boolean; color: ColorValue }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: focused ? "700" : "500", color }}>{label}</Text>
  );
}

export default function TabsLayout() {
  const { user, isLoading } = useAuth();
  const { theme } = useAppTheme();
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Same ONB-001 gate as the web app's (app)/layout.tsx: a fresh sign-up that never finished or skipped
  // onboarding gets bounced there regardless of which tab route it lands on first. A user with no
  // onboarding_state row at all predates this feature and is left alone.
  useEffect(() => {
    if (isLoading || !user) return;
    api
      .get<{ completedAt: string | null; skippedAt: string | null } | null>("/v1/onboarding/state")
      .then((state) => {
        if (state && !state.completedAt && !state.skippedAt) {
          router.replace("/onboarding");
        } else {
          setOnboardingChecked(true);
        }
      })
      .catch(() => setOnboardingChecked(true));
  }, [isLoading, user]);

  if (isLoading || (user && !onboardingChecked)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.bgCanvas }}>
        <ActivityIndicator color={theme.colors.brandDefault} />
      </View>
    );
  }

  if (!user) return <Redirect href="/sign-in" />;

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
        options={{ title: "Home", tabBarIcon: ({ focused, color }) => <TabIcon label="🏠" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="inbox"
        options={{ title: "Inbox", tabBarIcon: ({ focused, color }) => <TabIcon label="📥" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="ask"
        options={{ title: "Ask", tabBarIcon: ({ focused, color }) => <TabIcon label="💬" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="life"
        options={{ title: "Life", tabBarIcon: ({ focused, color }) => <TabIcon label="🗂️" focused={focused} color={color} /> }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: ({ focused, color }) => <TabIcon label="⚙️" focused={focused} color={color} /> }}
      />
    </Tabs>
  );
}
