import { Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

export function EmptyState({ title, description }: { title: string; description: string }) {
  const { theme } = useAppTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radius.lg,
        padding: 32,
        alignItems: "center",
        gap: 6,
      }}
    >
      <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary, textAlign: "center" }}>{title}</Text>
      <Text style={{ fontSize: 14, color: theme.colors.textTertiary, textAlign: "center" }}>{description}</Text>
    </View>
  );
}
