import { ScrollView, View, type ScrollViewProps } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppTheme } from "@/lib/theme-context";

export function Screen({ children, contentContainerStyle, ...props }: ScrollViewProps) {
  const { theme } = useAppTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bgCanvas }} edges={["top"]}>
      <ScrollView
        contentContainerStyle={[{ padding: 16, gap: 16 }, contentContainerStyle]}
        keyboardShouldPersistTaps="handled"
        {...props}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function CenteredScreen({ children }: { children: React.ReactNode }) {
  const { theme } = useAppTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.bgCanvas }}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>{children}</View>
    </SafeAreaView>
  );
}
