import { ActivityIndicator, Pressable, Text, type PressableProps } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

type Variant = "primary" | "secondary" | "ghost" | "critical";

interface ButtonProps extends Omit<PressableProps, "children"> {
  variant?: Variant;
  loading?: boolean;
  children: string;
}

export function Button({ variant = "primary", loading, disabled, children, style, ...props }: ButtonProps) {
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
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
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
      {/* numberOfLines=1: a button squeezed for space by a sibling should never wrap its label onto a
          second line, where it would just get clipped by this button's fixed height instead. */}
      <Text numberOfLines={1} style={{ color: textColor, fontSize: 16, fontWeight: "600", flexShrink: 1 }}>
        {children}
      </Text>
    </Pressable>
  );
}
