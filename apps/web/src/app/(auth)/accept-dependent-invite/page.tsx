"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";

interface DependentTransitionInvitePeek {
  householdId: string;
  householdName: string;
  dependentDisplayName: string;
  invitedEmail: string | null;
}

/**
 * FAM-001 "later invite/transition path when appropriate" — the accept side of a dependent-profile ->
 * own-account transition invite. Mirrors accept-invite/page.tsx's shape exactly (peek by token, sign-in/
 * sign-up prompt when logged out, wrong-account guard, accept action), minus a decline option — there's no
 * "decline" endpoint for this flow, since an admin/guardian can already cancel a still-pending invite from
 * the household settings page (revoke-transition), and a signed-in-but-uninterested invitee can simply not
 * accept it.
 */
export default function AcceptDependentInvitePage() {
  const router = useRouter();
  const { user, isLoading: sessionLoading } = useSession();
  // `undefined` = "haven't read window.location.search yet"; `null` = "read it, no token param" — see
  // accept-invite/page.tsx's identical pattern for why these must be distinct.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [invite, setInvite] = useState<DependentTransitionInvitePeek | null>(null);
  const [peekError, setPeekError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  useEffect(() => {
    if (!token) return;
    api
      .get<DependentTransitionInvitePeek>(`/v1/households/dependent-transition-invite?token=${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch((err) => setPeekError(err instanceof ApiError ? err.message : "Something went wrong. Please try again."));
  }, [token]);

  async function onAccept() {
    if (!token) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      await api.post<{ householdId: string }>("/v1/households/accept-dependent-transition", { token });
      setAccepted(true);
      setTimeout(() => router.push("/home"), 1500);
    } catch (err) {
      setAcceptError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setAccepting(false);
    }
  }

  if (token === undefined || sessionLoading) return null;

  if (!token) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Invalid invite link</h1>
          <p className="text-sm text-secondary">This link is missing its invite token.</p>
        </CardBody>
      </Card>
    );
  }

  if (peekError) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Invite link invalid</h1>
          <p className="text-sm text-secondary">{peekError}</p>
        </CardBody>
      </Card>
    );
  }

  if (accepted) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">You're all set!</h1>
          <p className="text-sm text-secondary">
            Your account is now linked to {invite?.dependentDisplayName}'s profile in {invite?.householdName}. Taking you to your home…
          </p>
        </CardBody>
      </Card>
    );
  }

  if (!invite) return null;

  const redirectTo = `/accept-dependent-invite?token=${encodeURIComponent(token)}`;

  if (!user) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Link your own account</h1>
          <p className="text-sm text-secondary">
            {invite.householdName} has invited {invite.dependentDisplayName} to have their own Veynlo account. Sign in or create an
            account with {invite.invitedEmail} to accept.
          </p>
          <div className="space-y-2">
            <Link href={`/sign-in?redirectTo=${encodeURIComponent(redirectTo)}`} className="block">
              <Button className="w-full">Sign in</Button>
            </Link>
            <Link
              href={`/sign-up?redirectTo=${encodeURIComponent(redirectTo)}&email=${encodeURIComponent(invite.invitedEmail ?? "")}`}
              className="block"
            >
              <Button variant="secondary" className="w-full">
                Create an account
              </Button>
            </Link>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (user.email !== invite.invitedEmail) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Wrong account</h1>
          <p className="text-sm text-secondary">
            This invite was sent to {invite.invitedEmail}, but you're signed in as {user.email}. Sign in with that account to accept it.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <h1 className="text-lg font-semibold text-primary">Link your own account</h1>
        <p className="text-sm text-secondary">
          {invite.householdName} has invited you to have your own Veynlo account for {invite.dependentDisplayName}'s profile. Everything
          already there stays visible to you and the rest of the household — this just adds your own independent sign-in.
        </p>
        {acceptError && (
          <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
            {acceptError}
          </p>
        )}
        <Button className="w-full" loading={accepting} onClick={onAccept}>
          Accept invite
        </Button>
      </CardBody>
    </Card>
  );
}
