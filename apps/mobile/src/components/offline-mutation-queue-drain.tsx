import { useEffect } from "react";
import { AppState } from "react-native";
import { useAuth } from "@/lib/auth-context";
import { offlineMutationQueue } from "@/lib/offline-mutation-queue";

/**
 * §42.6 "Offline sync and conflict model" — renders nothing; drains the offline mutation queue (see
 * offline-mutation-queue.ts) whenever the app comes to the foreground, mirroring
 * notification-capture-drain.tsx's identical AppState-triggered pattern for a different queue.
 *
 * This codebase has no `@react-native-community/netinfo` (or any other connectivity-detection library —
 * confirmed by searching both the mobile app and the workspace lockfile) and adding one wasn't an option
 * here: it would need `pnpm-lock.yaml` at the repo root regenerated, outside this task's apps/mobile-only
 * scope. Foreground transitions are a reasonable proxy instead — "the user just reopened the app" strongly
 * correlates with "connectivity may have changed since it was backgrounded" (came out of airplane mode,
 * walked back into wifi range, etc.) — combined with the opportunistic drain api-client.ts's own successful
 * requests don't trigger directly, but which the interval below covers: while anything is actually pending,
 * poll every 15s so a mutation queued mid-session (not just at launch/foreground) still syncs reasonably
 * promptly without the user having to background/foreground the app to nudge it.
 */
export function OfflineMutationQueueDrain() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user) return;

    offlineMutationQueue.drain();
    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") offlineMutationQueue.drain();
    });
    // Only while anything is actually pending — mirrors inbox.tsx's identical
    // poll-only-while-something-is-pending stance for voice-note transcription, rather than polling
    // indefinitely for an app that's usually fully synced.
    const interval = setInterval(async () => {
      const entries = await offlineMutationQueue.list();
      if (entries.some((entry) => entry.status === "pending")) offlineMutationQueue.drain();
    }, 15_000);

    return () => {
      appStateSub.remove();
      clearInterval(interval);
    };
  }, [user]);

  return null;
}
