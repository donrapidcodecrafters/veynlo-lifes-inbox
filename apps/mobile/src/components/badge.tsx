import { Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

type Tone = "neutral" | "critical" | "warning" | "positive" | "brand";

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: string }) {
  const { theme } = useAppTheme();
  const backgroundByTone: Record<Tone, string> = {
    neutral: theme.colors.bgSubtle,
    critical: theme.colors.criticalSubtleBg,
    warning: theme.colors.warningSubtleBg,
    positive: theme.colors.positiveSubtleBg,
    brand: theme.colors.brandSubtleBg,
  };
  const textByTone: Record<Tone, string> = {
    neutral: theme.colors.textSecondary,
    critical: theme.colors.criticalSubtleText,
    warning: theme.colors.warningSubtleText,
    positive: theme.colors.positiveSubtleText,
    brand: theme.colors.brandSubtleText,
  };

  return (
    <View
      style={{
        backgroundColor: backgroundByTone[tone],
        borderRadius: theme.radius.full,
        paddingHorizontal: 10,
        paddingVertical: 4,
        alignSelf: "flex-start",
      }}
    >
      {/* Fixed-height pill — cap Dynamic Type growth so the badge doesn't overflow into a wrapping mess of
          multi-line text inside what's meant to be a small inline tag. */}
      <Text style={{ fontSize: 12, fontWeight: "600", color: textByTone[tone] }} maxFontSizeMultiplier={1.5}>
        {children}
      </Text>
    </View>
  );
}
