"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useAdminSession } from "@/hooks/use-admin-session";
import { api } from "@/lib/api-client";

const NAV_LINKS = [
  { href: "/dashboard", labelKey: "dashboard" },
  { href: "/dashboard/merchants", labelKey: "merchants" },
  { href: "/dashboard/invites", labelKey: "invites" },
  { href: "/dashboard/admins", labelKey: "admins", superadminOnly: true },
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations("nav");
  const tLayout = useTranslations("layout");
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
      <header className="border-b border-border-subtle bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[0.9375rem] font-semibold text-primary">Veynlo Admin</span>
            <span className="shrink-0 rounded-full bg-subtle px-2 py-0.5 text-xs font-medium capitalize text-tertiary">
              {admin?.role}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="min-w-0 truncate text-sm text-tertiary">{admin?.email}</span>
            <button
              onClick={signOut}
              className="shrink-0 rounded-lg border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
            >
              {tLayout("signOut")}
            </button>
          </div>
        </div>
        <nav className="mt-3 flex flex-wrap items-center gap-1">
          {NAV_LINKS.filter((link) => !("superadminOnly" in link && link.superadminOnly) || admin?.role === "superadmin").map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                "rounded-lg px-3 py-1.5 text-sm font-medium " +
                (pathname === link.href ? "bg-subtle text-primary" : "text-tertiary hover:bg-subtle hover:text-primary")
              }
            >
              {t(link.labelKey)}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
