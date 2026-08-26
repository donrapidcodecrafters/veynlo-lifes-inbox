"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAdminSession } from "@/hooks/use-admin-session";

export default function RootPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAdminSession();

  useEffect(() => {
    if (isLoading) return;
    router.replace(isAuthenticated ? "/dashboard" : "/sign-in");
  }, [isAuthenticated, isLoading, router]);

  return null;
}
