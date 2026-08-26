import { Platform } from "react-native";
import Constants from "expo-constants";
import { tokenStore } from "./token-store";

const API_BASE_URL =
  Constants.expoConfig?.extra?.apiUrl ?? process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:4000";

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
    throw new ApiError(message, code, res.status, typeof body === "object" ? body?.fieldErrors : undefined);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data ? JSON.stringify(data) : undefined }),
  put: <T>(path: string, data?: unknown) => request<T>(path, { method: "PUT", body: data ? JSON.stringify(data) : undefined }),
};
