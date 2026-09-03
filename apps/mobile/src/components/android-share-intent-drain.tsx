import { useEffect } from "react";
import { Platform } from "react-native";
import { router } from "expo-router";
import { useShareIntent } from "expo-share-intent";
import { useAuth } from "@/lib/auth-context";

/**
 * Android's half of §Capture "Share sheet" (spec §52.1) — iOS already had a real share extension
 * (`src/share-extension.tsx`); Android had literally no share target at all, confirmed by a real audit
 * finding zero `SEND` intent-filter anywhere. `expo-share-intent` covers both platforms with one native
 * module, but this app's iOS share extension already has its own working custom-UI implementation, so
 * this is configured `disableIOS: true` in app.json — iOS keeps its existing extension untouched, and
 * this component only ever does anything on Android (see the README's own documented guidance for exactly
 * this "keep an existing iOS custom view, only add Android" scenario).
 *
 * Renders nothing — mirrors notification-capture-drain.tsx's identical shape. Reuses `/capture` (built
 * for the iOS share extension's deep-link handoff) rather than a separate Android-only screen: a shared
 * file/text is the same "hand it to `/capture`, already-authenticated user submits it" problem regardless
 * of which platform's native layer produced it.
 */
export function AndroidShareIntentDrain() {
  const { user } = useAuth();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent({ disabled: Platform.OS !== "android" });

  useEffect(() => {
    if (Platform.OS !== "android" || !user || !hasShareIntent) return;

    const file = shareIntent.files?.[0];
    if (file) {
      router.push({
        pathname: "/capture",
        params: { subject: "Shared file", filePath: file.path, mimeType: file.mimeType, fileName: file.fileName },
      });
    } else if (shareIntent.text) {
      router.push({ pathname: "/capture", params: { subject: "Shared text", body: shareIntent.text } });
    }
    resetShareIntent();
  }, [user, hasShareIntent, shareIntent]);

  return null;
}
