import { useEffect } from "react";
import { mutate } from "swr";

/**
 * §54.2 launch criteria #3 "Home, Inbox, Search/Ask and Timeline remain consistent through edits, source
 * updates, merge/unmerge, deletion and reconnect" — each page previously only ever revalidated its own
 * data after a mutation it made itself. A page mounted elsewhere at the time — Life open in another tab,
 * Timeline still showing a pre-correction summary — had no signal anything changed until its own next
 * focus/remount.
 *
 * Two mechanisms, because this app has two different data-fetching patterns and both need to hear about
 * it: SWR's global `mutate` (this import, not a hook-bound one) reaches every `useSWR` consumer of a
 * matching key regardless of which component fetched it first — covers Home/Life/Ask/Connections/People
 * with zero extra wiring on those pages. Inbox and Timeline fetch via plain `useEffect`+`api.get`, not
 * SWR, so they don't have a key in SWR's cache to invalidate — `onDomainCacheInvalidated` is a small
 * pub/sub those pages subscribe to instead, calling their own existing refresh function.
 *
 * Call `invalidateDomainCaches()` after any action that can change what a domain list/detail page or
 * Home/Timeline/Search show: an Inbox correct/confirm/dismiss (files or updates a real purchase/bill/
 * subscription/warranty/shipment/event), a merge/unmerge (people or merchants), a connection disconnect/
 * reconnect, or a manual domain state change (e.g. marking a purchase returned). Deliberately broad
 * rather than trying to track exactly which domain a given action touched — over-invalidating a few
 * extra keys costs one cheap GET each; under-invalidating is the actual bug this exists to close.
 */
export function invalidateDomainCaches(): void {
  void mutate(
    (key) => typeof key === "string" && DOMAIN_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)),
    undefined,
    { revalidate: true },
  );
  for (const listener of plainFetchListeners) listener();
}

const plainFetchListeners = new Set<() => void>();

/** For a page that fetches via plain `useEffect`+`api.get` rather than `useSWR` — re-runs `onInvalidate`
 * (typically that page's own existing refresh/load function) whenever any page elsewhere calls
 * `invalidateDomainCaches()`. */
export function useDomainCacheInvalidation(onInvalidate: () => void): void {
  useEffect(() => {
    plainFetchListeners.add(onInvalidate);
    return () => {
      plainFetchListeners.delete(onInvalidate);
    };
  }, [onInvalidate]);
}

const DOMAIN_CACHE_PREFIXES = [
  "/v1/inbox",
  "/v1/purchases",
  "/v1/bills",
  "/v1/subscriptions",
  "/v1/warranties",
  "/v1/shipments",
  "/v1/returns",
  "/v1/events",
  "/v1/tasks",
  "/v1/timeline",
  "/v1/home",
  "/v1/search",
  "/v1/people",
  "/v1/documents",
  "/v1/connections",
  "/v1/schedule",
];
