import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { api } from "./api-client";

const OPT_IN_KEY = "veynlo_notification_capture_opt_in";

/**
 * §32 messaging capture boundaries — Android-only "message capture" (SMS/RCS bill/appointment reminders
 * via Notification Access, not a default-SMS-app takeover). Gated three ways, all of which must hold
 * before anything native ever runs: platform is Android, the remote `android_notification_capture`
 * feature flag is on (kill switch if Google Play objects to this after review), and the user has
 * explicitly opted in on-device (a native OS "Notification Access" grant is a separate, additional gate
 * on top of this — see the native module's isListenerEnabled()).
 */
export const notificationCaptureStore = {
  async isOptedIn(): Promise<boolean> {
    if (Platform.OS !== "android") return false;
    const raw = await SecureStore.getItemAsync(OPT_IN_KEY);
    return raw === "true";
  },
  async setOptedIn(enabled: boolean): Promise<void> {
    // Confirmed live (Playwright against `expo start --web`): every other function in this module
    // early-returns on `Platform.OS !== "android"` before touching anything native, but this one didn't —
    // `expo-secure-store`'s web build (`ExpoSecureStore.web.js`) exports `{}`, so `SecureStore.setItemAsync`
    // (which calls `ExpoSecureStore.setValueWithKeyAsync` internally) throws `TypeError: ... is not a
    // function`. Since the caller (message-capture.tsx's `toggleOptIn`) awaits this with no try/catch, that
    // became an unhandled rejection — React Native Web's full-screen "Uncaught Error" dev overlay, same
    // crash class already fixed on privacy/data-export/billing. This feature is Android-only by design (see
    // this file's own doc comment), so web/iOS should no-op here exactly like `isOptedIn()` already does,
    // not attempt to persist anything.
    if (Platform.OS !== "android") return;
    await SecureStore.setItemAsync(OPT_IN_KEY, String(enabled));
  },
};

export async function isNotificationCaptureFeatureEnabled(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    const flags = await api.get<Record<string, boolean>>("/v1/feature-flags");
    return flags.android_notification_capture === true;
  } catch {
    return false; // fail closed — a flag-fetch failure must never be treated as "on"
  }
}

/** Lazily required so importing this file on iOS/web never touches a module that only exists on Android. */
function nativeModule() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../../modules/veynlo-notification-capture/src/VeynloNotificationCaptureModule").default as {
    isListenerEnabled(): boolean;
    openNotificationAccessSettings(): void;
    getPendingCaptures(): Array<{ title: string; text: string; postedAt: number }>;
    clearCaptures(): void;
  };
}

export function isListenerEnabled(): boolean {
  if (Platform.OS !== "android") return false;
  return nativeModule().isListenerEnabled();
}

export function openNotificationAccessSettings(): void {
  if (Platform.OS !== "android") return;
  nativeModule().openNotificationAccessSettings();
}

/** Call on app foreground (or a manual "Check now") — submits every queued capture through the same
 * manual-text pipeline every other capture surface already uses, then clears the native queue. */
export async function drainPendingCaptures(): Promise<number> {
  if (Platform.OS !== "android") return 0;
  const pending = nativeModule().getPendingCaptures();
  if (pending.length === 0) return 0;
  for (const capture of pending) {
    await api
      .post("/v1/ingestion/manual", { subject: capture.title, bodyText: capture.text })
      .catch(() => {}); // one bad item shouldn't block the rest of the queue from draining
  }
  nativeModule().clearCaptures();
  return pending.length;
}
