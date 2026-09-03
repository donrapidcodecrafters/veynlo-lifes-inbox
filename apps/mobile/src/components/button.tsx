import { ActivityIndicator, Pressable, Text, type PressableProps } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

type Variant = "primary" | "secondary" | "ghost" | "critical";

interface ButtonProps extends Omit<PressableProps, "children"> {
  variant?: Variant;
  loading?: boolean;
  children: string;
  /** Overrides the spoken label — the visible text (`children`) is used automatically otherwise, so this
   * is only needed when the label alone is ambiguous out of context (rare for this component). */
  accessibilityLabel?: string;
}

export function Button({
  variant = "primary",
  loading,
  disabled,
  children,
  style,
  accessibilityLabel,
  accessibilityHint,
  ...props
}: ButtonProps) {
  const { theme } = useAppTheme();

  const backgroundColor =
    variant === "primary"
      ? theme.colors.brandDefault
      : variant === "critical"
        ? theme.colors.critical
        : variant === "secondary"
          ? theme.colors.bgSurface
          : "transparent";
  const textColor = variant === "primary" || variant === "critical" ? theme.colors.textOnBrand : theme.colors.textPrimary;
  const borderColor = variant === "secondary" ? theme.colors.borderDefault : "transparent";

  return (
    <Pressable
      accessibilityRole="button"
      // Without an explicit role, a Pressable renders as a bare, role-less <div> under react-native-web
      // (confirmed live: every Button in the app — Add, Create list, Done, Accept/Decline, Approve, Delete
      // — has no `role` attribute at all), which is invisible to screen readers and unreachable by
      // Playwright/Testing-Library's standard `getByRole("button")` query, not just a cosmetic gap. Native
      // VoiceOver/TalkBack need the same `accessibilityRole` to announce "button" too, so this isn't a
      // web-only fix.
      // `accessibilityLabel` defaults to the visible text so VoiceOver/TalkBack always has something to
      // read even while `loading` swaps in a spinner alongside it; callers only need to override it when
      // the visible copy alone would be ambiguous (e.g. several "Remove" buttons in a list).
      accessibilityLabel={accessibilityLabel ?? children}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      style={(state) => [
        {
          backgroundColor,
          borderColor,
          borderWidth: variant === "secondary" ? 1 : 0,
          borderRadius: theme.radius.md,
          height: 48,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: disabled || loading ? 0.5 : state.pressed ? 0.85 : 1,
        },
        typeof style === "function" ? style(state) : style,
      ]}
      {...props}
    >
      {loading && <ActivityIndicator color={textColor} size="small" />}
      {/* `maxFontSizeMultiplier` caps Dynamic Type growth here — this row has a fixed 48px height, so
          letting the label scale unbounded would clip it instead of the button reflowing; the cap still
          leaves plenty of room to grow for low-vision users before that happens. */}
      <Text style={{ color: textColor, fontSize: 16, fontWeight: "600" }} maxFontSizeMultiplier={1.8}>
        {children}
      </Text>
    </Pressable>
  );
}
