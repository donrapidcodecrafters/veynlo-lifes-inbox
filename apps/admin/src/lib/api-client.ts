const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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

/**
 * Bug fix: found live on dashboard/admins' "Create admin" form — submitting a too-long display name
 * rendered the generic "Request body failed validation." (ZodValidationPipe's own top-level `message`;
 * see services/api/src/common/zod-validation.pipe.ts), giving the operator no indication of what was
 * actually wrong. The pipe already puts the useful per-field message in `fieldErrors`; every page's error
 * handler here now goes through this helper (mirroring apps/web's identical fix) so a real field-level
 * message wins over the generic one whenever the server sent one.
 */
export function apiErrorMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) {
    const firstFieldError = err.fieldErrors && Object.values(err.fieldErrors).flat()[0];
    return firstFieldError || err.message;
  }
  return fallback;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      // §28.7 CSRF mitigation (services/api/src/common/csrf.ts) — see apps/web's identical header for why.
      "x-veynlo-csrf": "1",
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    // Same reasoning as apps/web/src/lib/api-client.ts's identical check: a 401 from any endpoint other
    // than the admin sign-in endpoint itself means the admin session cookie is missing/revoked/expired,
    // not "wrong credentials" (which the sign-in page needs to show inline). Guarded against the current
    // path already being /sign-in — the sign-in page itself calls useAdminSession() (GET /v1/admin/me) to
    // detect an already-authenticated visitor, and that call 401s for every signed-out visitor; without
    // this guard a hard `window.location.href` reload back to the same /sign-in page fires on every load,
    // an infinite reload loop.
    if (
      res.status === 401 &&
      !path.startsWith("/v1/admin/auth/sign-in") &&
      typeof window !== "undefined" &&
      window.location.pathname !== "/sign-in"
    ) {
      window.location.href = "/sign-in";
    }
    const message = typeof body === "object" && body?.message ? body.message : "Something went wrong.";
    const code = typeof body === "object" && body?.code ? body.code : "UNKNOWN_ERROR";
    const fieldErrors = typeof body === "object" && body?.fieldErrors ? body.fieldErrors : undefined;
    throw new ApiError(message, code, res.status, fieldErrors);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
};

export const swrFetcher = <T,>(path: string) => api.get<T>(path);
