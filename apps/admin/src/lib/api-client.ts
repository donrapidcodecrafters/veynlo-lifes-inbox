const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
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
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    // Same reasoning as apps/web/src/lib/api-client.ts's identical check: a 401 from any endpoint other
    // than the admin sign-in endpoint itself means the admin session cookie is missing/revoked/expired,
    // not "wrong credentials" (which the sign-in page needs to show inline).
    if (res.status === 401 && !path.startsWith("/v1/admin/auth/sign-in") && typeof window !== "undefined") {
      window.location.href = "/sign-in";
    }
    const message = typeof body === "object" && body?.message ? body.message : "Something went wrong.";
    const code = typeof body === "object" && body?.code ? body.code : "UNKNOWN_ERROR";
    throw new ApiError(message, code, res.status);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
};

export const swrFetcher = <T,>(path: string) => api.get<T>(path);
