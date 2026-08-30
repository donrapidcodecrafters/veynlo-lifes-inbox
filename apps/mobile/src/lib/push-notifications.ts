import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { api } from "./api-client";

/** Matches NotificationDeliveryService.deliver()'s `categoryId: "attention_actionable"` — only sent when
 * the notification carries a `linkedAttentionItemId`, which is what puts these action buttons on it. */
const ATTENTION_ACTIONABLE_CATEGORY = "attention_actionable";

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

/** Registers the OS-level action buttons ("Resolve"/"Snooze 1h"/"Dismiss") a push notification can carry
 * when it's tagged `categoryId: "attention_actionable"`. Device-level, not user-specific — safe to call on
 * every app start regardless of sign-in state. No-op on web (no native notification category UI there). */
export async function registerNotificationCategoriesAsync(): Promise<void> {
  if (Platform.OS === "web") return;
  await Notifications.setNotificationCategoryAsync(ATTENTION_ACTIONABLE_CATEGORY, [
    { identifier: "resolve", buttonTitle: "Resolve" },
    { identifier: "snooze_1h", buttonTitle: "Snooze 1h" },
    { identifier: "dismiss", buttonTitle: "Dismiss" },
  ]);
}

/**
 * Routes a tap or action-button press on a delivered notification to the same attention-item endpoints
 * the in-app Home screen already uses, then records the acknowledgment via `POST /v1/notifications/:id/ack`
 * — the substrate a later escalation ladder/fatigue-feedback mechanism builds on.
 *
 * `linkedAttentionItemId` is only present in `data` when the notification was actually tagged
 * `attention_actionable` (see NotificationDeliveryService.deliver()), which is also the only case where
 * the OS would have shown action buttons in the first place — so a missing id here only ever happens for
 * a plain tap (e.g. a daily brief), where only the ack call applies.
 */
export async function handleNotificationResponse(response: Notifications.NotificationResponse): Promise<void> {
  const data = response.notification.request.content.data as { notificationId?: string; linkedAttentionItemId?: string } | undefined;
  const notificationId = data?.notificationId;
  const linkedAttentionItemId = data?.linkedAttentionItemId;

  if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) {
    if (notificationId) await api.post(`/v1/notifications/${notificationId}/ack`, { action: "opened" }).catch(() => {});
    router.push("/notifications");
    return;
  }

  if (!notificationId || !linkedAttentionItemId) return;

  switch (response.actionIdentifier) {
    case "resolve":
      await api.post(`/v1/attention/${linkedAttentionItemId}/resolve`).catch(() => {});
      await api.post(`/v1/notifications/${notificationId}/ack`, { action: "resolved" }).catch(() => {});
      break;
    case "snooze_1h": {
      const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await api.post(`/v1/attention/${linkedAttentionItemId}/snooze`, { until }).catch(() => {});
      await api.post(`/v1/notifications/${notificationId}/ack`, { action: "snoozed" }).catch(() => {});
      break;
    }
    case "dismiss":
      await api.post(`/v1/attention/${linkedAttentionItemId}/dismiss`).catch(() => {});
      await api.post(`/v1/notifications/${notificationId}/ack`, { action: "dismissed" }).catch(() => {});
      break;
  }
}
