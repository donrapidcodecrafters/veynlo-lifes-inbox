"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAdminSession } from "@/hooks/use-admin-session";
import { api } from "@/lib/api-client";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { admin, isLoading, isAuthenticated, refresh } = useAdminSession();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/sign-in");
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) return null;
  if (!isAuthenticated) return null;

  async function signOut() {
    await api.post("/v1/admin/auth/sign-out");
    await refresh();
    router.push("/sign-in");
  }

  return (
    <div className="min-h-dvh bg-canvas">
      <header className="flex items-center justify-between border-b border-border-subtle bg-surface px-6 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[0.9375rem] font-semibold text-primary">Veynlo Admin</span>
          <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-medium capitalize text-tertiary">
            {admin?.role}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-tertiary">{admin?.email}</span>
          <button onClick={signOut} className="rounded-lg border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle">
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-[1200px] px-6 py-8">{children}</main>
    </div>
  );
}
