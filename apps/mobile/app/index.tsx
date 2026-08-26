import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";

export default function IndexRoute() {
  const { user, isLoading } = useAuth();
  const { theme } = useAppTheme();

  if (isLoading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.bgCanvas }}>
        <ActivityIndicator color={theme.colors.brandDefault} />
      </View>
    );
  }

  return <Redirect href={user ? "/(tabs)" : "/sign-in"} />;
}
