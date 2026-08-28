import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import type { ThemeMode } from "@/lib/theme";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { mode, setMode, theme } = useAppTheme();

  async function onSignOut() {
    await signOut();
    router.replace("/sign-in");
  }

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Settings</Text>
      </View>

      <Card style={{ gap: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{user?.displayName}</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{user?.email}</Text>
      </Card>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
          Appearance
        </Text>
        <Card style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.bgSubtle }}>
          {THEME_OPTIONS.map((opt) => {
            const active = mode === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setMode(opt.value)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: theme.radius.sm,
                  backgroundColor: active ? theme.colors.bgSurface : "transparent",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Data</Text>
        <Button variant="secondary" onPress={() => router.push("/connections")}>
          Connections
        </Button>
      </View>

      <Button variant="secondary" onPress={onSignOut}>
        Sign out
      </Button>
    </Screen>
  );
}
