import { useEffect } from "react";
import { Platform } from "react-native";
import { useShareIntent } from "expo-share-intent";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api-client";

/**
 * §Connections/Capture "Share sheet" — Android's half of this MVP requirement. iOS already has a real,
 * dedicated Share Extension (`share-extension.tsx`, its own native target). Android has no equivalent
 * concept — no separate extension process, just an Intent the OS delivers straight to this app — so
 * `expo-share-intent` (Android-only here: `disabled` on every other platform, and the Android-only
 * `androidIntentFilters` config in app.json deliberately leaves the existing iOS extension's own
 * mechanism untouched rather than risk a second, conflicting iOS share target from this same package).
 *
 * Renders nothing — mirrors `NotificationCaptureDrain`'s identical "drain a native queue into the
 * ingestion pipeline, then clear it" shape.
 */
export function ShareIntentDrain() {
  const { user } = useAuth();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ disabled: Platform.OS !== "android" });

  useEffect(() => {
    if (Platform.OS !== "android" || !user || !hasShareIntent) return;

    async function file() {
      try {
        if (shareIntent.webUrl) {
          await api.post("/v1/ingestion/url", { url: shareIntent.webUrl });
        } else if (shareIntent.text) {
          const firstLine = shareIntent.text.trim().split("\n")[0]?.slice(0, 500) || "Shared item";
          await api.post("/v1/ingestion/manual", { subject: firstLine, bodyText: shareIntent.text });
        }
      } finally {
        resetShareIntent();
      }
    }

    file();
  }, [hasShareIntent, shareIntent, user, resetShareIntent]);

  return null;
}
