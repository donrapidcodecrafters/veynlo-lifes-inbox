"use client";

import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";

export interface AdminSessionUser {
  id: string;
  email: string;
  role: "support" | "superadmin";
}

export function useAdminSession() {
  const { data, error, isLoading, mutate } = useSWR<AdminSessionUser>("/v1/admin/me", swrFetcher, {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });

  return {
    admin: data ?? null,
    isLoading,
    isAuthenticated: !error && Boolean(data),
    refresh: mutate,
  };
}
