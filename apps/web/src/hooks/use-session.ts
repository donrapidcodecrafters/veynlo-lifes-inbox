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
  aiProcessingEnabled: boolean;
  // PRIV-002 grace period — non-null while `status === "deletion_pending"`, null otherwise.
  scheduledDeletionAt: string | null;
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
