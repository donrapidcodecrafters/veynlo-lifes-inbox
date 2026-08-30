import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api-client";
import { registerForPushNotificationsAsync, registerNotificationCategoriesAsync, handleNotificationResponse } from "@/lib/push-notifications";

/** Renders nothing — fires once per sign-in, registering this device's Expo push token with the server
 * (`POST /v1/auth/push-token`) so `NotificationDeliveryService` can actually deliver push-channel
 * notifications instead of silently falling back to email for every user. Also registers the
 * "attention_actionable" notification category (OS-level action buttons) and listens for taps/action
 * presses on delivered notifications for the lifetime of the app — both device-level setup, not gated on
 * sign-in the way push-token registration above is. */
export function PushRegistration() {
  const { user } = useAuth();
  const registeredForUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!user || registeredForUserId.current === user.id) return;
    registeredForUserId.current = user.id;
    (async () => {
      const token = await registerForPushNotificationsAsync();
      if (token) {
        await api.post("/v1/auth/push-token", { pushToken: token }).catch(() => {});
      }
    })();
  }, [user]);

  useEffect(() => {
    registerNotificationCategoriesAsync().catch(() => {});
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleNotificationResponse(response).catch(() => {});
    });
    return () => subscription.remove();
  }, []);

  return null;
}
