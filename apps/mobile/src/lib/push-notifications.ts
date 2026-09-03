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
