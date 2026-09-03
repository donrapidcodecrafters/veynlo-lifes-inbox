"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { useSession } from "@/hooks/use-session";
import { AppShell } from "@/components/layout/app-shell";
import { api, ApiError, swrFetcher } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { FinancialPrivacyProvider } from "@/lib/financial-privacy-context";

// ONB-001 "after sign-up (or on first sign-in if no onboarding has been completed)" — checked once here,
// for every `(app)` route, so a user who leaves mid-flow and comes back (refresh, or a later sign-in)
// resumes at their saved step no matter which page they land on first. `needsOnboarding` is false for a
// pre-existing account with no onboarding_state row at all (see OnboardingService.getState), so this never
// retroactively drops an existing user into a first-run flow they never had. The onboarding page itself is
// always reachable and always offers "Skip for now" — this redirect steers people toward it, it doesn't
// trap them; skipping reaches a normal Home exactly like today's no-onboarding behavior.
interface OnboardingNeedCheck {
  needsOnboarding: boolean;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, isAuthenticated, isLoading, refresh } = useSession();
  const { data: onboarding } = useSWR<OnboardingNeedCheck>(
    isAuthenticated && user?.status !== "deletion_pending" ? "/v1/onboarding/state" : null,
    swrFetcher,
    { revalidateOnFocus: false },
  );

  useEffect(() => {
    if (!isLoading && !isAuthenticated) router.replace("/sign-in");
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (onboarding?.needsOnboarding && pathname !== "/onboarding") router.replace("/onboarding");
  }, [onboarding, pathname, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <div className="size-6 animate-spin rounded-full border-2 border-brand border-t-transparent" aria-label="Loading" />
      </div>
    );
  }

  if (!isAuthenticated) return null;

  // PRIV-002 "grace period if used" — a `deletion_pending` account CAN sign in (see AuthGuard/
  // IdentityService.signIn's own doc comments), but is restricted to exactly this screen: cancel the
  // deletion, or sign out. Every other route/API call this app would otherwise make is blocked server-side
  // (AuthGuard's `@AllowDuringDeletion()` allowlist), so gating the whole authenticated shell here — rather
  // than letting the user navigate into pages that would just silently fail their own data fetches — is
  // the honest, single place to surface "why can't I do anything" and the one action that fixes it.
  if (user?.status === "deletion_pending") {
    return <DeletionPendingScreen scheduledDeletionAt={user.scheduledDeletionAt} onCancelled={refresh} />;
  }

  return (
    <FinancialPrivacyProvider>
      <AppShell>{children}</AppShell>
    </FinancialPrivacyProvider>
  );
}

function DeletionPendingScreen({ scheduledDeletionAt, onCancelled }: { scheduledDeletionAt: string | null; onCancelled: () => void }) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const daysLeft = scheduledDeletionAt
    ? Math.max(0, Math.ceil((new Date(scheduledDeletionAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  async function cancelDeletion() {
    setCancelling(true);
    setError(null);
    try {
      await api.post("/v1/auth/cancel-deletion");
      await onCancelled();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel deletion. Please try again.");
      setCancelling(false);
    }
  }

  async function signOut() {
    await api.post("/v1/auth/sign-out");
    router.push("/sign-in");
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="max-w-md">
        <CardBody className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold text-primary">Your account is scheduled for deletion</h1>
            <p className="mt-2 text-sm text-tertiary">
              {scheduledDeletionAt ? (
                <>
                  Everything will be permanently deleted on{" "}
                  <strong className="text-primary">{new Date(scheduledDeletionAt).toLocaleDateString(undefined, { dateStyle: "long" })}</strong>
                  {daysLeft !== null && ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} from now)`}. Until then, you can cancel and keep your account
                  exactly as it was.
                </>
              ) : (
                "Your account is scheduled for deletion. You can cancel and keep your account exactly as it was."
              )}
            </p>
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {error}
            </p>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={cancelDeletion} loading={cancelling} className="whitespace-nowrap">
              Cancel deletion &amp; keep my account
            </Button>
            <Button variant="secondary" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
