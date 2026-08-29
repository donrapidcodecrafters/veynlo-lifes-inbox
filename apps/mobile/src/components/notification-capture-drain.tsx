import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { useAuth } from "@/lib/auth-context";
import { notificationCaptureStore, drainPendingCaptures } from "@/lib/notification-capture";

/** Renders nothing — drains any queued Android message captures (see notification-capture.ts) whenever
 * the app comes to the foreground, so a bill/appointment text caught while Veynlo wasn't open still makes
 * it into the Inbox promptly rather than sitting in the native queue until the next unrelated screen visit. */
export function NotificationCaptureDrain() {
  const { user } = useAuth();

  useEffect(() => {
    if (Platform.OS !== "android" || !user) return;

    async function drainIfOptedIn() {
      if (await notificationCaptureStore.isOptedIn()) await drainPendingCaptures().catch(() => {});
    }

    drainIfOptedIn();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") drainIfOptedIn();
    });
    return () => sub.remove();
  }, [user]);

  return null;
}
