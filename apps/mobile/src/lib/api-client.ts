import { Platform } from "react-native";
import Constants from "expo-constants";
import { router } from "expo-router";
import { tokenStore } from "./token-store";

// The Android emulator's "localhost" refers to the emulator itself, not the host machine running the API —
// 10.0.2.2 is the documented loopback alias Android provides for reaching the host. iOS Simulator and web
// share the host's network namespace directly, so plain localhost works there.
const DEFAULT_API_BASE_URL = Platform.OS === "android" ? "http://10.0.2.2:4000" : "http://localhost:4000";

const API_BASE_URL = Constants.expoConfig?.extra?.apiUrl ?? process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_BASE_URL;

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
    // Same reasoning as apps/web/src/lib/api-client.ts's identical check: a 401 from any endpoint other
    // than sign-in/sign-up itself means the stored token is invalid/revoked/expired, not "wrong
    // credentials" (which sign-in/sign-up need to show inline). Without this, a screen with a stale token
    // just failed every fetch forever with no visible error and no way back to sign-in short of
    // force-quitting the app.
    if (res.status === 401 && !path.startsWith("/v1/auth/sign-in") && !path.startsWith("/v1/auth/sign-up")) {
      await tokenStore.clear();
      router.replace("/sign-in");
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
  patch: <T>(path: string, data?: unknown) => request<T>(path, { method: "PATCH", body: data ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
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
