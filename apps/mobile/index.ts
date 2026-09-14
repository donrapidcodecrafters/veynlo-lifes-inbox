/**
 * Hermes' promise-rejection tracker, enabled UNCONDITIONALLY.
 *
 * React Native turns this on itself only under __DEV__, so in a release build an unhandled rejection is
 * swallowed silently — no log, no crash, nothing. This app has no other error reporting either (no
 * Sentry, no Crashlytics, no ErrorBoundary, no ErrorUtils.setGlobalHandler), so such a rejection is
 * currently invisible in production rather than merely unreported.
 *
 * Deliberately before the expo-router import below: the tracker has to exist before any application code
 * gets a chance to create a promise.
 *
 * `allRejections: true` reports every rejection that reaches the end of a tick unhandled, not only those
 * that stay unhandled forever — onHandled fires afterwards for anything that was merely handled late, so
 * a late .catch() is distinguishable from a genuine leak rather than being missed entirely.
 */
interface HermesRejectionTracking {
  enablePromiseRejectionTracker?: (options: {
    allRejections: boolean;
    onUnhandled: (id: number, rejection: unknown) => void;
    onHandled: (id: number) => void;
  }) => void;
}

const hermes = (globalThis as { HermesInternal?: HermesRejectionTracking }).HermesInternal;
hermes?.enablePromiseRejectionTracker?.({
  allRejections: true,
  onUnhandled: (id, rejection) => {
    const error = rejection instanceof Error ? rejection : new Error(String(rejection));
    // console.error rather than a throw: a rejection nobody awaited should be reported, not turned into
    // a crash the user sees. On Android this reaches `adb logcat`; on iOS, the device console.
    console.error(`[unhandled-rejection:${id}] ${error.message}`, error.stack ?? "(no stack)");
  },
  onHandled: (id) => {
    // Handled late — worth distinguishing from a genuine leak, so an investigation of the line above
    // knows this one resolved itself.
    console.warn(`[unhandled-rejection:${id}] was handled later than the tick it rejected in`);
  },
});

import "expo-router/entry";
