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
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    // A 401 from any endpoint OTHER than sign-in/sign-up itself means the session cookie is missing/
    // revoked/expired, not "wrong credentials" (sign-in/sign-up legitimately 401 on bad input, which the
    // caller needs to show inline, not have this silently redirect away from). Without this, every screen
    // that lost its session just failed every subsequent fetch forever with no visible error — SWR pages
    // render blank (data stays undefined, matching neither the loading nor empty-state branch) and pages
    // using useEffect+.then().finally() (no .catch) render an empty state indistinguishable from a
    // genuinely empty account.
    if (res.status === 401 && !path.startsWith("/v1/auth/sign-in") && !path.startsWith("/v1/auth/sign-up") && typeof window !== "undefined") {
      window.location.href = "/sign-in";
    }
    const message = typeof body === "object" && body?.message ? body.message : "Something went wrong.";
    const code = typeof body === "object" && body?.code ? body.code : "UNKNOWN_ERROR";
    throw new ApiError(message, code, res.status, typeof body === "object" ? body?.fieldErrors : undefined);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, formData: FormData) =>
    fetch(`${API_BASE_URL}${path}`, { method: "POST", credentials: "include", body: formData }).then(async (res) => {
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
