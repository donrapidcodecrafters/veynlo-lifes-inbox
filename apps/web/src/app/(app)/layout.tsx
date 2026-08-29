"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/use-session";
import { api } from "@/lib/api-client";
import { AppShell } from "@/components/layout/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useSession();
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/sign-in");
  }, [isAuthenticated, isLoading, router]);

  // A user with an incomplete ONB-001 onboarding wizard (fresh sign-up, never finished or skipped it) gets
  // bounced here regardless of which route they land on first — covers the OAuth sign-up path, whose
  // callback always redirects to /home with no way to distinguish "brand new" from "returning user."
  // A user with no onboarding_state row at all predates this feature and is left alone (see
  // OnboardingService.getState).
  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    api
      .get<{ completedAt: string | null; skippedAt: string | null } | null>("/v1/onboarding/state")
      .then((state) => {
        if (state && !state.completedAt && !state.skippedAt) {
          router.replace("/onboarding");
        } else {
          setOnboardingChecked(true);
        }
      })
      .catch(() => setOnboardingChecked(true));
  }, [isLoading, isAuthenticated, router]);

  if (isLoading || (isAuthenticated && !onboardingChecked)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="size-6 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Loading" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  return <AppShell>{children}</AppShell>;
}
