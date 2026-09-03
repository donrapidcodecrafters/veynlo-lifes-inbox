import { Linking, Platform, Text, View } from "react-native";
import { API_BASE_URL } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Button } from "@/components/button";

/**
 * §Account/security "Apple/Google/Microsoft/email authentication" — mobile had email/password only until
 * now; web already has all four. Opens the same `/v1/auth/<provider>/authorize` redirect endpoints the
 * web sign-in page navigates to directly, in the system browser (`Linking.openURL` — there's no in-app
 * fetch here, so there's no bearer token or cookie to attach; platform travels as a query param instead
 * of the usual `x-veynlo-platform` header for exactly that reason — see identity.controller.ts's own doc
 * comment on `coercePlatform`). The provider eventually redirects the system browser to
 * `veynlo://auth-callback`, which `app/auth-callback.tsx` (registered via expo-router the same way the
 * share extension's `capture` deep link already is) picks up to finish sign-in.
 */
export function OAuthSignInButtons() {
  const { theme } = useAppTheme();
  const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";

  function openProvider(provider: "google" | "microsoft" | "apple") {
    Linking.openURL(`${API_BASE_URL}/v1/auth/${provider}/authorize?platform=${platform}`);
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.borderDefault }} />
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>or continue with</Text>
        <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.borderDefault }} />
      </View>
      <Button variant="secondary" onPress={() => openProvider("google")}>
        Continue with Google
      </Button>
      <Button variant="secondary" onPress={() => openProvider("microsoft")}>
        Continue with Microsoft
      </Button>
      <Button variant="secondary" onPress={() => openProvider("apple")}>
        Continue with Apple
      </Button>
    </View>
  );
}
