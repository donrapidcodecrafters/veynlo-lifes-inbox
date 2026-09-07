import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { resolvePushRoute, type PushDeepLinkData } from "@/lib/push-deep-link";

/**
 * Renders nothing — navigates to whatever a tapped push notification was about.
 *
 * Before this existed there was no notification-response listener anywhere in the app, so tapping ANY
 * push just cold-launched to the Home tab: a recall alert, an overdue bill and a shipment update all
 * landed in the same place, with no way to tell which one the user had tapped. §16 requires the
 * destination to be correct from all three app states, so both are handled here:
 *
 *   - BACKGROUNDED / OPEN — `addNotificationResponseReceivedListener` fires on the tap.
 *   - CLOSED — the tap launches the process, so there is no listener yet when it happens.
 *     `getLastNotificationResponseAsync` replays the response that did the launching.
 *
 * Deliberately mounted next to <PushRegistration /> rather than folded into it: that component's job ends
 * once a token is registered, and this one has to keep running for the life of the app.
 */
export function PushNavigation() {
  const { user } = useAuth();
  // True once a push has taken over the screen. The next push then REPLACES that screen instead of
  // stacking on it — §16 explicitly asks that repeated notification opens not build an enormous stack,
  // and without this, ten taps means ten screens the user must back out of one at a time.
  const openedFromPush = useRef(false);
  // getLastNotificationResponseAsync keeps returning the same launch response for the life of the
  // process, so without this the cold-start navigation would re-fire on every auth change or remount and
  // yank the user back out of wherever they had since navigated.
  const handledColdStartId = useRef<string | null>(null);

  useEffect(() => {
    // expo-notifications' response listeners are a native-only API; on web `registerForPushNotificationsAsync`
    // already returns null and no push can arrive, so there is nothing to listen for.
    if (Platform.OS === "web") return;
    // Never navigate into an owner-scoped detail screen before there is a signed-in user to scope it to.
    // The effect re-runs when `user` appears, and the cold-start response is still waiting to be read.
    if (!user) return;

    function go(data: PushDeepLinkData | null | undefined) {
      const route = resolvePushRoute(data);
      if (!route) return; // the daily/weekly briefs — real notifications with no single target
      if (openedFromPush.current) router.replace(route);
      else router.push(route);
      openedFromPush.current = true;
    }

    let cancelled = false;

    (async () => {
      try {
        const launchResponse = await Notifications.getLastNotificationResponseAsync();
        if (cancelled || !launchResponse) return;
        const id = launchResponse.notification.request.identifier;
        if (handledColdStartId.current === id) return;
        handledColdStartId.current = id;
        go(launchResponse.notification.request.content.data as PushDeepLinkData | undefined);
      } catch {
        // A failure to read the launch response must never block app start — the user still lands on Home,
        // which is exactly the behaviour this component improves on rather than depends on.
      }
    })();

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      // Record the identifier here too: a tap that arrives while the app is running is fully handled by
      // this listener, and must not then be replayed as a "cold start" by a later remount.
      handledColdStartId.current = response.notification.request.identifier;
      go(response.notification.request.content.data as PushDeepLinkData | undefined);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [user]);

  return null;
}
