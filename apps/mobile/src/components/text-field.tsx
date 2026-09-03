import { Text, TextInput, View, type TextInputProps } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

interface TextFieldProps extends TextInputProps {
  label: string;
  error?: string;
}

export function TextField({ label, error, style, ...props }: TextFieldProps) {
  const { theme } = useAppTheme();
  return (
    <View style={{ gap: 6 }}>
      {/* Visible label above the input isn't automatically associated with it for a screen reader the way
          an HTML <label for=""> is — the TextInput below gets its own `accessibilityLabel` from this same
          string so VoiceOver/TalkBack announce it when the field is focused, even for the many callers that
          pass `label=""` and rely on a placeholder instead (recurrence-picker's numeric inputs, for one). */}
      {label ? <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }} maxFontSizeMultiplier={1.8}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={theme.colors.textTertiary}
        accessibilityLabel={props.accessibilityLabel ?? label ?? (typeof props.placeholder === "string" ? props.placeholder : undefined)}
        // RN's AccessibilityState has no "invalid" flag, so the error text travels as the hint instead —
        // announced right after the label/value whenever the field is focused with an error present.
        accessibilityHint={error ? error : props.accessibilityHint}
        // The box has a fixed 48px height; an unbounded Dynamic Type scale would clip the entered text
        // instead of the field growing, so cap it rather than disable scaling outright.
        maxFontSizeMultiplier={1.6}
        style={[
          {
            height: 48,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: error ? theme.colors.critical : theme.colors.borderDefault,
            paddingHorizontal: 14,
            fontSize: 16,
            color: theme.colors.textPrimary,
            backgroundColor: theme.colors.bgSurface,
          },
          style,
        ]}
        {...props}
      />
      {error && (
        <Text
          style={{ fontSize: 13, color: theme.colors.critical }}
          maxFontSizeMultiplier={1.8}
          accessibilityLiveRegion="polite"
        >
          {error}
        </Text>
      )}
    </View>
  );
}
