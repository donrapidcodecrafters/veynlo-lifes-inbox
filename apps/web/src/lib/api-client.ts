export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      "x-veynlo-platform": "web",
      // §28.7 CSRF mitigation (services/api/src/common/csrf.ts) — a plain HTML form can't set this, only
      // same-origin JS can, so its presence on every real request is what proves this one is real.
      "x-veynlo-csrf": "1",
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = typeof body === "object" && body?.message ? body.message : "Something went wrong.";
    const code = typeof body === "object" && body?.code ? body.code : "UNKNOWN_ERROR";
    // A 401 from any endpoint OTHER than the exemptions below means the session cookie is missing/
    // revoked/expired, not "wrong credentials" (sign-in/sign-up legitimately 401 on bad input, which the
    // caller needs to show inline, not have this silently redirect away from). Without this, every screen
    // that lost its session just failed every subsequent fetch forever with no visible error — SWR pages
    // render blank (data stays undefined, matching neither the loading nor empty-state branch) and pages
    // using useEffect+.then().finally() (no .catch) render an empty state indistinguishable from a
    // genuinely empty account.
    //
    // Two real bugs found live (browser-driven testing, not curl replay) in the original blanket version
    // of this check: (1) `GET /v1/auth/me` is `useSession()`'s own "am I logged in?" probe — a 401 there
    // for an anonymous visitor on a genuinely public page (e.g. `/accept-invite`) is expected data, not a
    // session-death signal, but the redirect fired before the page's own "you're not signed in" UI could
    // ever render, discarding the invite context entirely. (2) `PASSWORD_REQUIRED` is an intentional
    // step-up-auth signal (data-export, destructive connector-disconnect) meaning "you ARE signed in, we
    // just need you to re-confirm your password for this specific action" — not a dead session — but the
    // redirect fired before the caller's own password-prompt handling ever ran. `INVALID_CREDENTIALS` is
    // the same family of signal: every call site that returns it (sign-in, step-up re-verification,
    // delete-account) means "the password you just typed into a form on this page was wrong," never
    // "your session died" — the sign-in/sign-up case was already exempted by path, but delete-account's
    // own wrong-password case (same code, different endpoint) was not, and hit the exact same bug: the
    // user gets silently bounced away instead of seeing "Incorrect password." inline.
    const isSessionProbe = path.startsWith("/v1/auth/me");
    // AUTH-001 "Sign in with a passkey" — authentication-options/authentication-verify are hit BEFORE any
    // session exists (this IS how one gets created), exactly like sign-in/sign-up above; a failed/cancelled
    // passkey ceremony throws a 401 (PASSKEY_NOT_FOUND, PASSKEY_VERIFICATION_FAILED, ACCOUNT_SUSPENDED,
    // etc) that the sign-in page needs to show inline, not have this redirect away from mid-attempt while
    // already sitting on /sign-in.
    const isAuthEntry =
      path.startsWith("/v1/auth/sign-in") || path.startsWith("/v1/auth/sign-up") || path.startsWith("/v1/auth/passkeys/authentication");
    const isCredentialSignal = code === "PASSWORD_REQUIRED" || code === "INVALID_CREDENTIALS";
    // PRIV-002 grace period — a `deletion_pending` account CAN sign in (AuthGuard's own doc comment), so
    // this 401 means "you're signed in, but this specific route isn't on the allow-during-deletion list,"
    // not "your session died." Without this exemption, the very first non-allowlisted request the
    // `(app)` layout makes (e.g. the onboarding-state check) would bounce a legitimately-signed-in,
    // grace-period user straight back to /sign-in before AppLayout's own deletion-pending screen ever gets
    // a chance to render — see that layout's own handling of this status.
    const isDeletionPendingSignal = code === "ACCOUNT_DELETION_PENDING";
    if (res.status === 401 && !isAuthEntry && !isSessionProbe && !isCredentialSignal && !isDeletionPendingSignal && typeof window !== "undefined") {
      window.location.href = "/sign-in";
    }
    throw new ApiError(message, code, res.status, typeof body === "object" ? body?.fieldErrors : undefined);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, formData: FormData) =>
    fetch(`${API_BASE_URL}${path}`, { method: "POST", credentials: "include", headers: { "x-veynlo-csrf": "1" }, body: formData }).then(async (res) => {
      const body = await res.json();
      if (!res.ok) {
        if (res.status === 401 && typeof window !== "undefined") window.location.href = "/sign-in";
        throw new ApiError(body.message ?? "Upload failed.", body.code ?? "UPLOAD_FAILED", res.status);
      }
      return body as T;
    }),
};

/** Shared SWR fetcher so every `useSWR(path)` call uses the same auth/error semantics. */
export const swrFetcher = <T,>(path: string) => api.get<T>(path);
