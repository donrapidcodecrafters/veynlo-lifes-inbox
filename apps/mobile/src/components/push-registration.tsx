import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api-client";
import { registerForPushNotificationsAsync } from "@/lib/push-notifications";

/** Renders nothing — fires once per sign-in, registering this device's Expo push token with the server
 * (`POST /v1/auth/push-token`) so `NotificationDeliveryService` can actually deliver push-channel
 * notifications instead of silently falling back to email for every user. */
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

  return null;
}
