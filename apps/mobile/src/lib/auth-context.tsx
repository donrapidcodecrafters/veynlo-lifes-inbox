import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api-client";
import { tokenStore } from "./token-store";
import { emergencyBinderCache } from "./emergency-binder-cache";
import { tripOfflineCache } from "./trip-offline-cache";
import { offlineMutationQueue } from "./offline-mutation-queue";
import { authenticatePasskey } from "./passkey";
import type { AuthenticationOptionsJSON } from "./passkey.types";

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  // §38.2 "Internationalization" — `GET /v1/auth/me` already returns the full `users` row (minus
  // `passwordHash`, see IdentityService.me), which has always included this column; it just wasn't
  // declared here, so nothing on mobile ever read it. Threaded into src/lib/i18n/i18n-provider.tsx
  // the same way apps/web's identical `SessionUser.locale` (hooks/use-session.ts) feeds its provider.
  locale: string;
  themePreference: "system" | "light" | "dark";
  // PRIV-002 grace period — "active" for every normal account; "deletion_pending" once
  // POST /v1/auth/delete-account has run, until either the 14 days elapse or POST /v1/auth/cancel-deletion
  // reactivates it. Mirrors apps/web's identical SessionUser field (hooks/use-session.ts).
  status: string;
  /** Non-null only while `status === "deletion_pending"`. */
  scheduledDeletionAt: string | null;
}

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string, inviteCode?: string) => Promise<void>;
  completeOAuthSignIn: (token: string, refreshToken: string) => Promise<void>;
  /** AUTH-001 "Sign in with a passkey" — a usernameless/discoverable-credential ceremony (see
   * passkey.native.ts's own doc comment); returns "cancelled" rather than throwing when the user backs out
   * of the native passkey prompt, so the sign-in screen can quietly do nothing instead of showing an error. */
  signInWithPasskey: () => Promise<"success" | "cancelled">;
  signOut: () => Promise<void>;
  /** PRIV-002 grace period — re-fetches `/v1/auth/me` so the deletion-pending gate (see
   * deletion-pending-gate.tsx) can pick up `status` flipping back to "active" right after
   * POST /v1/auth/cancel-deletion, without a full sign-out/sign-in round trip. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<SessionUser>("/v1/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      // Always attempt a refresh on launch, even with no locally-stored bearer token — the web-preview
      // flow (Platform.OS === "web") authenticates via the httpOnly cookie instead, which this process
      // has no visibility into until the request comes back. Worst case with neither: a 401, correctly
      // treated as "not signed in".
      await refresh();
      setIsLoading(false);
    })();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<{ userId: string; token?: string; refreshToken?: string }>("/v1/auth/sign-in", { email, password });
      if (result.token) await tokenStore.set(result.token);
      if (result.refreshToken) await tokenStore.setRefreshToken(result.refreshToken);
      await refresh();
    },
    [refresh],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string, inviteCode?: string) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await api.post<{ userId: string; token?: string; refreshToken?: string }>("/v1/auth/sign-up", {
        email,
        password,
        displayName,
        timezone,
        inviteCode,
      });
      if (result.token) await tokenStore.set(result.token);
      if (result.refreshToken) await tokenStore.setRefreshToken(result.refreshToken);
      await refresh();
    },
    [refresh],
  );

  /** Landing point for `apps/mobile/app/auth-callback.tsx` — the `veynlo://auth-callback` deep link
   * Google/Microsoft/Apple sign-in redirects the system browser to (see
   * services/api/src/modules/identity/identity.controller.ts's `finishOAuthSignIn`). Same token storage
   * as email sign-in/sign-up above, just a different origin for the token. */
  const completeOAuthSignIn = useCallback(
    async (token: string, refreshToken: string) => {
      await tokenStore.set(token);
      await tokenStore.setRefreshToken(refreshToken);
      await refresh();
    },
    [refresh],
  );

  /**
   * AUTH-001 "Sign in with a passkey" — mirrors apps/web's identical flow (see sign-in/page.tsx's
   * `onPasskeySignIn`): fetch a challenge, let the native passkey UI run, hand the assertion back for real
   * server-side verification, then store the returned bearer token exactly like `completeOAuthSignIn`
   * already does for the OAuth deep-link handback — a passkey sign-in ends in the SAME session mechanism.
   */
  const signInWithPasskey = useCallback(async (): Promise<"success" | "cancelled"> => {
    const { options, challengeToken } = await api.post<{ options: AuthenticationOptionsJSON; challengeToken: string }>("/v1/auth/passkeys/authentication-options", {});
    const ceremony = await authenticatePasskey(options);
    if (ceremony.status === "cancelled") return "cancelled";
    if (ceremony.status === "error") throw new Error(ceremony.message);
    const result = await api.post<{ userId: string; token?: string; refreshToken?: string }>("/v1/auth/passkeys/authentication-verify", {
      response: ceremony.response,
      challengeToken,
    });
    if (result.token) await tokenStore.set(result.token);
    if (result.refreshToken) await tokenStore.setRefreshToken(result.refreshToken);
    await refresh();
    return "success";
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.post("/v1/auth/sign-out");
    } catch {
      // Token may already be invalid/expired — clearing local state still succeeds either way.
    }
    await tokenStore.clear();
    await tokenStore.clearRefreshToken();
    // Found while auditing the emergency binder feature: its offline cache (household roster, vehicle
    // VINs, property addresses, medications/emergency-instructions text) previously outlived sign-out
    // entirely, so a second account signing in on this same device could hit its fetch-failure fallback
    // and see the FIRST account's cached data, bypassing that second account's own membership/step-up
    // checks. Cleared here as the primary guard; emergency-binder.tsx also independently checks the
    // cache's tagged owner against the current user before ever displaying it, in case a future sign-out
    // path (e.g. a forced/background session expiry) skips this.
    await emergencyBinderCache.clear();
    // Same cross-account leak guard, same call site — see trip-offline-cache.ts's own doc comment.
    await tripOfflineCache.clear();
    // §42.6 "Offline sync and conflict model" — a mutation queued while signed in as this account must
    // never be replayed after a different account signs in on the same device. See
    // offline-mutation-queue.ts's `clear()` doc comment for why this (unlike the two caches above) doesn't
    // also need a separate ownerUserId-tag defense-in-depth.
    await offlineMutationQueue.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, signIn, signUp, completeOAuthSignIn, signInWithPasskey, signOut, refreshUser: refresh }),
    [user, isLoading, signIn, signUp, completeOAuthSignIn, signInWithPasskey, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };
