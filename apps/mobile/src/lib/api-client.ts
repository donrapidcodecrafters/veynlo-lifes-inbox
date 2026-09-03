import { Platform } from "react-native";
import Constants from "expo-constants";
import { router } from "expo-router";
import { tokenStore } from "./token-store";
import { configureExecutor, offlineMutationQueue, type MutationMethod } from "./offline-mutation-queue";

// The Android emulator's "localhost" refers to the emulator itself, not the host machine running the API —
// 10.0.2.2 is the documented loopback alias Android provides for reaching the host. iOS Simulator and web
// share the host's network namespace directly, so plain localhost works there.
const DEFAULT_API_BASE_URL = Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000";

// Exported for the one caller that needs to build a URL to open in the system browser rather than fetch
// directly — Google/Microsoft/Apple sign-in's `Linking.openURL` calls (see app/sign-in.tsx, app/sign-up.tsx).
export const API_BASE_URL = Constants.expoConfig?.extra?.apiUrl ?? process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const AUTH_PATHS_WITHOUT_REFRESH = ["/v1/auth/sign-in", "/v1/auth/sign-up", "/v1/auth/refresh"];

// Deduplicates concurrent refresh attempts — several screens can 401 around the same moment (the access
// token just expired), and firing one `/v1/auth/refresh` per failed request would race the rotation logic
// against itself: the second call would present a refresh token the first call already rotated away,
// triggering reuse-detection and revoking the session for a legitimate client. Every concurrent 401 instead
// awaits the same in-flight refresh.
let refreshPromise: Promise<boolean> | null = null;

async function tryRefreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = await tokenStore.getRefreshToken();
      if (!refreshToken) return false;
      try {
        const res = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "x-veynlo-platform": Platform.OS },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { token?: string; refreshToken?: string };
        if (!body.token) return false;
        await tokenStore.set(body.token);
        if (body.refreshToken) await tokenStore.setRefreshToken(body.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export async function request<T>(path: string, init?: RequestInit, isRetryAfterRefresh = false): Promise<T> {
  const token = await tokenStore.get();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    // Harmless on native (fetch there has no cookie jar to speak of); on `expo start --web` this is a real
    // browser, so it makes the same httpOnly-cookie flow apps/web uses work here too — Platform.OS reports
    // "web" in both cases, and the server's platform-gated behavior (cookie vs. bearer token in the sign-in
    // response body) is exactly what we want either way.
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      "x-veynlo-platform": Platform.OS,
      // §28.7 CSRF mitigation (services/api/src/common/csrf.ts) — only actually load-bearing on the
      // `expo start --web` cookie-auth path (native's bearer token isn't a CSRF-relevant transport at
      // all), sent unconditionally anyway since it's harmless either way and keeps this one code path
      // correct regardless of platform.
      "x-veynlo-csrf": "1",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = typeof body === "object" && body?.message ? body.message : "Something went wrong.";
    const code = typeof body === "object" && body?.code ? body.code : "UNKNOWN_ERROR";
    // Same reasoning as apps/web/src/lib/api-client.ts's identical check: a 401 from any endpoint other
    // than the exemptions below means the stored token is invalid/revoked/expired, not "wrong
    // credentials" (which sign-in/sign-up need to show inline). Without this, a screen with a stale token
    // just failed every fetch forever with no visible error and no way back to sign-in short of
    // force-quitting the app. Before giving up, one silent refresh attempt — the whole point of the
    // rotating-refresh-token flow is that an expired 14-day access token shouldn't force a password
    // re-prompt on its own; only a failed refresh (no refresh token, or the session was actually revoked)
    // should.
    //
    // Three real bugs found live (Playwright against `expo start --web`, not curl replay): (1) this
    // unconditional `router.replace("/sign-in")` fired even on `/v1/auth/me`'s own routine "am I logged
    // in?" probe, clobbering an in-flight navigation to `/sign-up` on a cold app load — sign-up was
    // unreachable by any direct link/bookmark, only an in-app SPA nav (no remount) worked. (2)
    // `PASSWORD_REQUIRED`/`INVALID_CREDENTIALS` are step-up-auth signals (data-export, delete-account,
    // destructive connector-disconnect) meaning "you ARE signed in, this specific password attempt was
    // wrong/needed" — not a dead session — but the same unconditional handler cleared real tokens and
    // navigated away before the caller's own inline-error/password-prompt handling ever ran, so e.g.
    // typing the wrong password to delete-account silently dumped the user on Home with no error shown.
    const isSessionProbe = path.startsWith("/v1/auth/me");
    const isCredentialSignal = code === "PASSWORD_REQUIRED" || code === "INVALID_CREDENTIALS";
    // PRIV-002 grace period — a `deletion_pending` account CAN sign in (see auth-context.tsx's SessionUser
    // doc comment), so this 401 means "you're signed in, but this route isn't on the server's
    // allow-during-deletion list," not "your session died." Without this exemption, the very first
    // non-allowlisted request this app makes after such a sign-in (e.g. the tab layout's own onboarding
    // check, or a push-registration call) would clear real tokens and bounce the user straight back to
    // /sign-in before deletion-pending-gate.tsx's own screen — mounted above the whole Stack specifically
    // to handle this — ever gets a chance to render. Mirrors apps/web's identical exemption
    // (apps/web/src/lib/api-client.ts).
    const isDeletionPendingSignal = code === "ACCOUNT_DELETION_PENDING";
    const isExempt =
      AUTH_PATHS_WITHOUT_REFRESH.some((p) => path.startsWith(p)) || isSessionProbe || isCredentialSignal || isDeletionPendingSignal;
    if (res.status === 401 && !isExempt) {
      if (!isRetryAfterRefresh && (await tryRefreshSession())) {
        return request<T>(path, init, true);
      }
      await tokenStore.clear();
      await tokenStore.clearRefreshToken();
      router.replace("/sign-in");
    }
    throw new ApiError(message, code, res.status, typeof body === "object" ? body?.fieldErrors : undefined);
  }
  return body as T;
}

// §42.6 "Offline sync and conflict model" — registered once at module load so offline-mutation-queue.ts's
// drain loop can actually replay a queued mutation through the exact same auth/refresh/CSRF pipeline as
// every other request, without that file needing to import anything from here (see its own top doc comment
// for why: a static import of react-native/expo-constants there would break its plain-Node unit test).
configureExecutor(async ({ method, path, body }) => {
  try {
    const data = await request(path, { method, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { outcome: "success", data };
  } catch (err) {
    // The one distinction this whole mechanism exists to make: `err instanceof ApiError` only happens
    // after `request()` got a real HTTP response and it wasn't `res.ok` — a genuine answer from the server,
    // never something to blindly retry (see offline-mutation-queue.ts's `drain()`). Anything else here is
    // `fetch()` itself throwing (TypeError: Network request failed, a timeout, DNS failure, airplane
    // mode) — no response was received at all, which is the actual connectivity failure this queue exists
    // to recover from.
    if (err instanceof ApiError) return { outcome: "rejected", status: err.status, message: err.message };
    return { outcome: "network_failure" };
  }
});

/** Result of a mutation attempted through `api.postQueueable`/`putQueueable` — see those functions' own
 * doc comment. `queued: true` is not an error: the caller should treat it as an optimistic "this will
 * happen, just not yet" success, not surface it as a failure. */
export type QueueableResult<T> = { queued: false; data: T } | { queued: true; idempotencyKey: string };

async function requestQueueable<T>(method: MutationMethod, path: string, body: unknown, description: string): Promise<QueueableResult<T>> {
  try {
    const data = await request<T>(path, { method, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { queued: false, data };
  } catch (err) {
    // A real rejection (auth failure, validation error, a 403/404 that has nothing to do with
    // connectivity) still throws exactly like `api.post`/`put` always have — only "no response at all"
    // gets the offline-queue treatment. See the `configureExecutor` callback above for the identical check.
    if (err instanceof ApiError) throw err;
    const mutation = await offlineMutationQueue.enqueue({ method, path, body, description });
    return { queued: true, idempotencyKey: mutation.id };
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  /**
   * §42.6 "offline command receives a client-generated command/idempotency ID and remains visibly Pending
   * until server confirms" — opt-in per call site (NOT a blanket behavior change for every mutating
   * endpoint: something like sign-in/delete-account must never be silently queued while offline, since
   * there's nothing "optimistic" about a command that hasn't actually authenticated/deleted anything yet).
   * Wired into the handful of screens where "queued, will sync" is an honest and safe thing to tell the
   * user — see apps/mobile/app/(tabs)/index.tsx's `resolve()` and apps/mobile/app/list/[id].tsx's
   * `addItem()`/`toggleChecked()` for the actual call sites, and offline-mutation-queue.ts's `drain()` for
   * what happens to a queued entry once connectivity returns (including the conflict case, §42.6's
   * "high-impact ... require review when conflicting").
   */
  postQueueable: <T>(path: string, data: unknown, description: string) => requestQueueable<T>("POST", path, data, description),
  putQueueable: <T>(path: string, data: unknown, description: string) => requestQueueable<T>("PUT", path, data, description),
  /**
   * Multipart upload. On native, React Native's fetch/FormData specially recognizes a `{ uri, name, type }`
   * object appended in place of a web `File`/`Blob` and builds the multipart part from it directly. Under
   * `expo start --web` this is a real browser FormData, which silently stringifies a plain object instead
   * of attaching it as a file part (confirmed live — the request reached the server with no file at all) —
   * so the web branch fetches the picker's blob: URL into a real Blob first. Field order matters (same
   * note as apps/web's identical helper): @fastify/multipart's request.file() only captures fields that
   * arrive BEFORE the file part, so the file must be appended last.
   */
  async upload<T>(path: string, fields: Record<string, string>, file: { uri: string; name: string; type: string }): Promise<T> {
    const token = await tokenStore.get();
    const formData = new FormData();
    for (const [key, value] of Object.entries(fields)) formData.append(key, value);
    if (Platform.OS === "web") {
      const blob = await (await fetch(file.uri)).blob();
      formData.append("file", blob, file.name);
    } else {
      formData.append("file", file as unknown as Blob);
    }

    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "x-veynlo-platform": Platform.OS,
        "x-veynlo-csrf": "1",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
    const isJson = res.headers.get("content-type")?.includes("application/json");
    const body = isJson ? await res.json() : await res.text();
    if (!res.ok) {
      const message = typeof body === "object" && body?.message ? body.message : "Upload failed.";
      const code = typeof body === "object" && body?.code ? body.code : "UPLOAD_FAILED";
      throw new ApiError(message, code, res.status);
    }
    return body as T;
  },
};
