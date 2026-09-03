import { ScrollView, Text } from "react-native";
import { useAppTheme } from "@/lib/theme-context";
import type { SectionTabOption } from "@/lib/use-section-tabs";

interface SectionTabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SectionTabOption<T>[];
  accessibilityLabel: string;
}

/**
 * Horizontal scrollable pill tab strip for a screen with several full data sections stacked below it
 * (Life, Home, ...) — same visual shape as documents.tsx's own filter-chip row (rounded-full pill,
 * brand-filled when active, horizontal ScrollView so it never wraps or crowds a narrow phone width)
 * reused here instead of inventing a new control, pairing with the `useSectionTabs` hook for
 * AsyncStorage-backed persistence.
 */
export function SectionTabs<T extends string>({ value, onChange, options, accessibilityLabel }: SectionTabsProps<T>) {
  const { theme } = useAppTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel={accessibilityLabel}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Text
            key={o.value}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={{
              fontSize: 13,
              fontWeight: "600",
              paddingHorizontal: 12,
              paddingVertical: 7,
              borderRadius: theme.radius.full,
              backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
              color: active ? theme.colors.textOnBrand : theme.colors.textSecondary,
              overflow: "hidden",
            }}
          >
            {o.label}
          </Text>
        );
      })}
    </ScrollView>
  );
}
