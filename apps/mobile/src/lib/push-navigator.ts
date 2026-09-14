import { resolvePushRoute, type PushDeepLinkData } from "./push-deep-link";

/**
 * The navigation DECISIONS behind a push tap, separated from the React component that wires them to
 * expo-notifications and expo-router.
 *
 * This exists because of an honest verification gap. Whether a real OS notification tap actually invokes
 * `addNotificationResponseReceivedListener` could not be verified on iOS Simulator — no technique available
 * there (banner tap in any app state, Notification Center, lock screen, video diagnostic) could register a
 * genuine tap, and that is a driver/OS-privilege boundary rather than a "try harder" problem. Android is no
 * better placed here: with no EAS `projectId` configured, `registerForPushNotificationsAsync` returns null,
 * so there is no real push token, and injecting a notification that routes through expo's own listener
 * would mean shipping test-only code into the app — the exact class of thing just removed from it.
 *
 * So the delivery half stays unverified and is recorded that way. But the LOGIC half does not have to be:
 * everything below is pure, and the two rules that were previously only reasoned about are now pinned by
 * tests —
 *
 *   1. §16 stack depth. The first push navigates ON TOP of wherever the user was, so Back returns there.
 *      Every subsequent push REPLACES the screen the previous push opened, so ten taps never means ten
 *      screens to back out of.
 *   2. Cold-start replay. `getLastNotificationResponseAsync` keeps returning the same launch response for
 *      the life of the process, so the same notification must not be acted on twice — otherwise a remount
 *      (or auth resolving) yanks the user out of wherever they had since navigated.
 */
export interface PushNavigatorTarget {
  push(route: string): void;
  replace(route: string): void;
}

export type PushNavigationOutcome = "navigated" | "no-route";

export interface PushNavigator {
  /** True if this notification has already been acted on — the cold-start replay guard. */
  alreadyHandled(notificationId: string): boolean;
  /** Records a notification as acted on, whether or not it produced navigation. */
  markHandled(notificationId: string): void;
  /** Navigates to whatever the payload points at. "no-route" for the briefs, which have no target. */
  go(data: PushDeepLinkData | null | undefined): PushNavigationOutcome;
}

export function createPushNavigator(target: PushNavigatorTarget): PushNavigator {
  // Whether a push currently owns the screen. Drives push-vs-replace; see rule 1 above.
  let openedFromPush = false;
  let lastHandledId: string | null = null;

  return {
    alreadyHandled: (notificationId) => lastHandledId === notificationId,
    markHandled: (notificationId) => {
      lastHandledId = notificationId;
    },
    go(data) {
      const route = resolvePushRoute(data);
      // No target — the daily/weekly briefs. Leave the user wherever the app opened rather than bouncing
      // them to Home, and critically do NOT set openedFromPush: nothing was opened, so the next push must
      // still push rather than replace a screen it did not put there.
      if (!route) return "no-route";
      if (openedFromPush) target.replace(route);
      else target.push(route);
      openedFromPush = true;
      return "navigated";
    },
  };
}
