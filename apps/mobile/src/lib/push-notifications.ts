import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

/**
 * Returns a real Expo push token, or null if push isn't usable right now — no EAS project configured
 * (`app.json`'s `extra.eas.projectId`, unset in this deployment), running under `expo start --web` (Expo
 * push tokens require a native device), or the user declined the permission prompt. Same "not configured"
 * degradation as every other optional external dependency: the caller just skips registration silently.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  if (Platform.OS === "web") return null;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return null;

  // TEMPORARY, __DEV__-only QA accommodation — not shipped in any real build. The permission *prompt*
  // itself is a native system alert, and (confirmed live, same root cause as the Share Extension's
  // already-documented unautomatable tap-through) it does not respond to any synthetic click this QA
  // pass could produce — no `xcrun simctl privacy` service covers notifications either (tried; Apple
  // doesn't expose one, unlike camera/calendar/contacts/location, which are TCC-backed and do). Left
  // unanswered, the prompt blocks the entire app on every launch. Skipping the *request* call here (never
  // faking a "granted" result) means push registration honestly reports "not available" for this pass —
  // called out explicitly in the QA report — while unblocking every other screen. Remove before shipping
  // any release build.
  if (__DEV__) {
    try {
      const FileSystem = await import("expo-file-system/legacy");
      const marker = `${FileSystem.documentDirectory}qa-automation-mode`;
      if ((await FileSystem.getInfoAsync(marker)).exists) return null;
    } catch {
      // Marker not present / not readable — fall through to the real permission flow below.
    }
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;

  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data;
  } catch {
    return null;
  }
}
