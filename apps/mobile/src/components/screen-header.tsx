import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAppTheme } from "@/lib/theme-context";

/** A simple back-button + title header for stack screens pushed on top of the tab bar (root Stack has headerShown: false globally). */
export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const { theme } = useAppTheme();
  const router = useRouter();

  return (
    <View style={{ gap: 4 }}>
      {router.canGoBack() && (
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ alignSelf: "flex-start", paddingVertical: 4 }}
        >
          <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.brandDefault }}>‹ Back</Text>
        </Pressable>
      )}
      <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>{title}</Text>
      {subtitle && <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>{subtitle}</Text>}
    </View>
  );
}
