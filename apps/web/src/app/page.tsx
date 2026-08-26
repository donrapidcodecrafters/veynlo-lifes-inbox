"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/use-session";

export default function RootPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useSession();

  useEffect(() => {
    if (isLoading) return;
    router.replace(isAuthenticated ? "/home" : "/sign-in");
  }, [isAuthenticated, isLoading, router]);

  return null;
}
