import AsyncStorage from "@react-native-async-storage/async-storage";

export interface EmergencyBinderPayload {
  household: { id: string; name: string };
  medicationsNotes: string | null;
  emergencyInstructions: string | null;
  members: Array<{ id: string; userId: string | null; role: string; relationshipLabel: string | null; status: string; displayName: string | null; email: string | null }>;
  dependents: Array<{ id: string; displayName: string; birthDate: string | null }>;
  vehicles: Array<{ id: string; label: string; make: string | null; model: string | null; year: number | null; vin: string | null }>;
  properties: Array<{ id: string; label: string; propertyType: string; address: string | null }>;
  pets: Array<{
    id: string;
    label: string;
    species: string | null;
    breed: string | null;
    microchipNumber: string | null;
    vetProviderName: string | null;
    insuranceProviderName: string | null;
    vaccinations: Array<{ label: string; expirationDate: unknown }>;
    medications: Array<{ medicationName: string; nextRefillDate: unknown; pharmacy: string | null }>;
  }>;
  documents: Array<{ id: string; title: string; documentType: string }>;
  generatedAt: string;
}

export interface CachedBinder {
  payload: EmergencyBinderPayload;
  cachedAtIso: string;
  /** The user this payload was fetched as — see the "Found and fixed" note below. Compared against the
   * CURRENTLY signed-in user (available offline from AuthContext's in-memory state, no network needed)
   * before this cache is ever shown, so a stale cache from a previous account on the same device can't
   * surface under a different one even if `clear()` on sign-out were ever missed or bypassed. */
  ownerUserId: string;
}

const CACHE_KEY = "veynlo_emergency_binder_cache_v1";

/**
 * Offline cache uses AsyncStorage, not expo-secure-store like token-store.ts/biometric-lock-store.ts —
 * this payload (household roster, vehicles, property, medications) is meaningfully larger and more
 * structured than the small secrets/preferences those two store, and AsyncStorage is the right tool for
 * that shape of data. Deliberately NOT the same tier as the auth token: this is cached app data behind its
 * own gate (biometric/password re-checked on every screen focus/app-foreground — see emergency-binder.tsx),
 * not a bearer credential.
 *
 * Known, DELIBERATE tradeoff (see docs/PHASE2_PENDING_CREDENTIALS.md's emergency-binder entry): AsyncStorage
 * has no at-rest encryption of its own — this JSON blob (household roster, vehicle VINs, property
 * addresses, medications/emergency-instructions free text) sits in plaintext in the app's local storage
 * file (SQLite on Android, a plist/RocksDB file on iOS), protected only by the OS's own device-level
 * encryption when the device is locked, not by anything Veynlo adds on top. Accepted for this one feature
 * because its entire point is being readable *offline*, in an emergency, when the server can't be reached
 * to decrypt anything — an encrypted-at-rest cache would need its own key, which either lives right next to
 * the ciphertext (defeating the purpose) or requires the same server round trip this cache exists to avoid.
 * The gate in front of it (biometric/password, re-checked on every focus and app-foreground) is the actual
 * control; this cache is intentionally at the same trust tier as "this data was visible on screen a moment
 * ago," not a hardened secrets store.
 *
 * Found and fixed while auditing this feature: nothing used to clear this cache on sign-out, so a second
 * account signing in on the same device — then opening this screen while offline — could see the FIRST
 * account's cached household data via the fetch-failure fallback, bypassing that second account's own
 * membership/step-up checks entirely (those only run against the live server call, never against this
 * local fallback). Two independent fixes, deliberately redundant with each other: `clear()` is now called
 * from auth-context.tsx's signOut, AND every cache entry is tagged with the `ownerUserId` it was fetched
 * as, which emergency-binder.tsx checks against the currently signed-in user (offline-available, no
 * network needed) before ever showing a cached payload — so a stale cross-account cache can't surface even
 * if the sign-out clear were ever missed, skipped (e.g. an app crash instead of a clean sign-out), or a
 * future code path forgets to call it.
 */
export const emergencyBinderCache = {
  async get(): Promise<CachedBinder | null> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_KEY);
      return raw ? (JSON.parse(raw) as CachedBinder) : null;
    } catch {
      return null;
    }
  },
  async set(payload: EmergencyBinderPayload, ownerUserId: string): Promise<void> {
    try {
      await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ payload, cachedAtIso: new Date().toISOString(), ownerUserId } satisfies CachedBinder));
    } catch {
      // Best-effort — a failed cache write shouldn't block showing the just-fetched data.
    }
  },
  async clear(): Promise<void> {
    try {
      await AsyncStorage.removeItem(CACHE_KEY);
    } catch {
      // Best-effort — matches get()/set()'s own swallow-and-continue stance.
    }
  },
};
