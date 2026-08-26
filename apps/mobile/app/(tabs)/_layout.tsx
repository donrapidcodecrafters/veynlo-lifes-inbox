import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, Text, View, type ColorValue } from "react-native";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";

function TabIcon({ label, focused, color }: { label: string; focused: boolean; color: ColorValue }) {
  return (
    <Text style={{ fontSize: 11, fontWeight: focused ? "700" : "500", color }}>{label}</Text>
  );
}

export default function TabsLayout() {
  const { user, isLoading } = useAuth();
  const { theme } = useAppTheme();

  if (isLoading) {
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
        name="settings"
        options={{ title: "Settings", tabBarIcon: ({ focused, color }) => <TabIcon label="⚙️" focused={focused} color={color} /> }}
      />
    </Tabs>
  );
}
