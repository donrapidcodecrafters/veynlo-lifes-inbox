import AsyncStorage from "@react-native-async-storage/async-storage";

/** One trip's full detail payload — same shape trip/[id].tsx's `TripDetail` interface expects, kept as
 * `unknown` here (this cache module has no reason to know the exact shape) and cast back by the caller. */
export interface CachedTrip {
  payload: unknown;
  cachedAtIso: string;
  /** Same cross-account leak guard as emergency-binder-cache.ts's own `ownerUserId` field — see its doc
   * comment for the full "found and fixed" rationale this mirrors exactly. */
  ownerUserId: string;
}

const CACHE_KEY_PREFIX = "veynlo_trip_cache_v1_";

/**
 * Phase 3 §26 "Travel & Reservations" offline travel pack — reuses the emergency-binder's offline-cache
 * pattern (apps/mobile/src/lib/emergency-binder-cache.ts, built + security-hardened earlier this session)
 * rather than inventing a new offline-caching approach. One key difference from that cache: a trip is one
 * of potentially many, so this is keyed per-trip-id (`CACHE_KEY_PREFIX + tripId`) rather than a single
 * fixed key — a traveler may want more than one upcoming trip available offline (e.g. checking a return
 * flight's details while the outbound leg's confirmation is also cached).
 *
 * Same AsyncStorage trust tier as the emergency binder cache (plaintext at rest, protected only by the
 * OS's device-level encryption when locked) — accepted for the same reason: the entire point is being
 * readable *offline*, mid-trip, when the server may not be reachable at all (airplane mode, no roaming
 * data, a hotel with no wifi yet). This is meaningfully less sensitive than the emergency binder's contents
 * (no VINs/medications; a trip's confirmationNumber/policyEvidenceText/travelCredits ARE still real
 * evidence, so this cache is not exposed on a trip's PUBLIC share view — see TripsService.publicShareContent).
 *
 * `ownerUserId` tagging + `clear()` on sign-out (wired in auth-context.tsx, same call site as
 * emergencyBinderCache.clear()) closes the identical cross-account leak class that cache was hardened
 * against: a stale cached trip from a previous account on the same device must never surface under a
 * different signed-in account, even if a future code path forgets to call `clear()`.
 */
export const tripOfflineCache = {
  async get(tripId: string, currentUserId: string): Promise<CachedTrip | null> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY_PREFIX + tripId);
      if (!raw) return null;
      const cached = JSON.parse(raw) as CachedTrip;
      return cached.ownerUserId === currentUserId ? cached : null;
    } catch {
      return null;
    }
  },
  async set(tripId: string, payload: unknown, ownerUserId: string): Promise<void> {
    try {
      await AsyncStorage.setItem(CACHE_KEY_PREFIX + tripId, JSON.stringify({ payload, cachedAtIso: new Date().toISOString(), ownerUserId } satisfies CachedTrip));
    } catch {
      // Best-effort — a failed cache write shouldn't block showing the just-fetched data.
    }
  },
  /** Clears every cached trip (not just one) — called on sign-out, same as emergencyBinderCache.clear(). */
  async clear(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const tripKeys = keys.filter((k) => k.startsWith(CACHE_KEY_PREFIX));
      if (tripKeys.length > 0) await AsyncStorage.multiRemove(tripKeys);
    } catch {
      // Best-effort — matches get()/set()'s own swallow-and-continue stance.
    }
  },
};
