import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Button } from "@/components/button";

/**
 * Landing spot for the `veynlo://capture` deep link the iOS Share Extension opens
 * (src/share-extension.tsx) — the extension itself has no access to this app's Keychain-stored session,
 * so it hands the captured text off here instead, where the user is already signed in.
 */
export default function CaptureScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ subject?: string; body?: string }>();
  const [state, setState] = useState<"submitting" | "done" | "error">("submitting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;
    const subject = params.subject?.trim();
    const bodyText = params.body?.trim();
    if (!subject || !bodyText) {
      setState("error");
      setErrorMessage("Nothing was shared.");
      return;
    }
    api
      .post("/v1/ingestion/manual", { subject, bodyText })
      .then(() => setState("done"))
      .catch((err) => {
        setState("error");
        setErrorMessage(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
      });
  }, [params.subject, params.body]);

  return (
    <Screen>
      <ScreenHeader title="Save to Veynlo" />
      <View style={{ alignItems: "center", gap: 12, paddingVertical: 24 }}>
        {state === "submitting" && <Text style={{ color: theme.colors.textTertiary }}>Saving what you shared…</Text>}
        {state === "done" && <Text style={{ color: theme.colors.textPrimary, fontWeight: "600" }}>Saved — it'll show up in your Inbox.</Text>}
        {state === "error" && <Text style={{ color: theme.colors.critical }}>{errorMessage}</Text>}
        <Button variant="secondary" onPress={() => router.replace("/(tabs)/inbox")}>
          Go to Inbox
        </Button>
      </View>
    </Screen>
  );
}
