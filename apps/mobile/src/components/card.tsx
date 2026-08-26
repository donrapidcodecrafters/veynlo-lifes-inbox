import { View, type ViewProps } from "react-native";
import { useAppTheme } from "@/lib/theme-context";

export function Card({ style, ...props }: ViewProps) {
  const { theme } = useAppTheme();
  return (
    <View
      style={[
        {
          backgroundColor: theme.colors.bgSurface,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: theme.colors.borderSubtle,
          padding: 16,
        },
        style,
      ]}
      {...props}
    />
  );
}
