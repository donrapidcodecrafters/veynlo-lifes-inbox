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
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>{label}</Text>
      <TextInput
        placeholderTextColor={theme.colors.textTertiary}
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
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </View>
  );
}
