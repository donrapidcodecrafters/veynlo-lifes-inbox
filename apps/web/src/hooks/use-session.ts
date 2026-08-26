"use client";

import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  locale: string;
  timezone: string;
  currency: string;
  status: string;
  themePreference: "system" | "light" | "dark";
}

export function useSession() {
  const { data, error, isLoading, mutate } = useSWR<SessionUser>("/v1/auth/me", swrFetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  return {
    user: data ?? null,
    isLoading,
    isAuthenticated: !error && Boolean(data),
    refresh: mutate,
  };
}
