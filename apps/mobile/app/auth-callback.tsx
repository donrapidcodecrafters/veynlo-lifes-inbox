import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRootNavigationState, router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Button } from "@/components/button";

const ERROR_MESSAGES: Record<string, string> = {
  oauth_not_configured: "That sign-in method isn't configured on this deployment yet.",
  oauth_failed: "Couldn't complete sign-in. Please try again.",
  missing_code: "That sign-in attempt was interrupted. Please try again.",
};

/**
 * Landing spot for the `veynlo://auth-callback` deep link Google/Microsoft/Apple sign-in redirects the
 * system browser to (see services/api/src/modules/identity/identity.controller.ts's `finishOAuthSignIn`).
 * Mirrors app/capture.tsx's own cold-launch/already-running-app deep-link handling — see that file's doc
 * comment for why `useRootNavigationState` + a deferred-to-next-tick `router.replace` is needed rather
 * than acting immediately, confirmed live on a real iOS Simulator for that flow.
 */
export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{ token?: string; refreshToken?: string; error?: string }>();
  const { completeOAuthSignIn } = useAuth();
  const { theme } = useAppTheme();
  const rootNavigationState = useRootNavigationState();
  const [state, setState] = useState<"working" | "error">("working");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (!rootNavigationState?.key || handled.current) return;
    handled.current = true;

    if (params.error) {
      setState("error");
      setErrorMessage(ERROR_MESSAGES[params.error] ?? "Couldn't complete sign-in. Please try again.");
      return;
    }
    if (!params.token || !params.refreshToken) {
      setState("error");
      setErrorMessage("That sign-in attempt was interrupted. Please try again.");
      return;
    }
    completeOAuthSignIn(params.token, params.refreshToken).then(() => {
      const timeoutId = setTimeout(() => router.replace("/(tabs)"), 0);
      return () => clearTimeout(timeoutId);
    });
  }, [rootNavigationState?.key, params.token, params.refreshToken, params.error, completeOAuthSignIn]);

  return (
    <Screen>
      <ScreenHeader title="Signing you in…" />
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 24 }}>
        {state === "working" && <Text style={{ color: theme.colors.textTertiary }}>Just a moment…</Text>}
        {state === "error" && (
          <>
            <Text style={{ color: theme.colors.critical }}>{errorMessage}</Text>
            <Button variant="secondary" onPress={() => router.replace("/sign-in")}>
              Back to sign in
            </Button>
          </>
        )}
      </View>
    </Screen>
  );
}
