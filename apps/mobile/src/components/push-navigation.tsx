import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import type { PushDeepLinkData } from "@/lib/push-deep-link";
import { createPushNavigator } from "@/lib/push-navigator";

/**
 * Renders nothing — navigates to whatever a tapped push notification was about.
 *
 * Before this existed there was no notification-response listener anywhere in the app, so tapping ANY
 * push just cold-launched to the Home tab: a recall alert, an overdue bill and a shipment update all
 * landed in the same place, with no way to tell which one the user had tapped. §16 requires the
 * destination to be correct from all three app states, so both paths are handled here:
 *
 *   - BACKGROUNDED / OPEN — `addNotificationResponseReceivedListener` fires on the tap.
 *   - CLOSED — the tap launches the process, so there is no listener yet when it happens.
 *     `getLastNotificationResponseAsync` replays the response that did the launching.
 *
 * Deliberately mounted next to <PushRegistration /> rather than folded into it: that component's job ends
 * once a token is registered, and this one has to keep running for the life of the app.
 *
 * All navigation DECISIONS live in createPushNavigator, which is pure and unit-tested. That split is
 * deliberate: whether a real OS tap actually invokes the listener below could not be verified on iOS
 * Simulator by any available technique, and Android cannot help either (no EAS projectId means no push
 * token, and faking one would mean shipping test-only code into the app). The delivery half is recorded as
 * unverified in the audit ledger; keeping the logic out here means the half that CAN be proven is proven.
 */
export function PushNavigation() {
  const { user } = useAuth();
  // Held in a ref so the push-vs-replace state and the replay guard survive re-renders and auth changes.
  const navigator = useRef(
    createPushNavigator({
      push: (route) => router.push(route),
      replace: (route) => router.replace(route),
    }),
  );

  useEffect(() => {
    // expo-notifications' response listeners are a native-only API; on web `registerForPushNotificationsAsync`
    // already returns null and no push can arrive, so there is nothing to listen for.
    if (Platform.OS === "web") return;
    // Never navigate into an owner-scoped detail screen before there is a signed-in user to scope it to.
    // The effect re-runs when `user` appears, and the cold-start response is still waiting to be read.
    if (!user) return;

    const nav = navigator.current;
    let cancelled = false;

    (async () => {
      try {
        const launchResponse = await Notifications.getLastNotificationResponseAsync();
        if (cancelled || !launchResponse) return;
        const id = launchResponse.notification.request.identifier;
        if (nav.alreadyHandled(id)) return;
        nav.markHandled(id);
        nav.go(launchResponse.notification.request.content.data as PushDeepLinkData | undefined);
      } catch {
        // A failure to read the launch response must never block app start — the user still lands on Home,
        // which is exactly the behaviour this component improves on rather than depends on.
      }
    })();

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      // Mark here too: a tap that arrives while the app is running is fully handled by this listener, and
      // must not then be replayed as a "cold start" by a later remount.
      nav.markHandled(response.notification.request.identifier);
      nav.go(response.notification.request.content.data as PushDeepLinkData | undefined);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [user]);

  return null;
}
