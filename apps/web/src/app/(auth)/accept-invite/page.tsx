"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";

interface InvitePeek {
  householdId: string;
  householdName: string;
  invitedEmail: string | null;
}

export default function AcceptInvitePage() {
  const router = useRouter();
  const { user, isLoading: sessionLoading } = useSession();
  // `undefined` = "haven't read window.location.search yet"; `null` = "read it, no token param" — see
  // reset-password/page.tsx's identical fix for why these must be distinct (a `setToken(null)` when
  // already initialized to `null` is a no-op React bails out of, permanently stranding a tokenless URL on
  // the "still loading" branch instead of ever reaching the "invalid link" one).
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [invite, setInvite] = useState<InvitePeek | null>(null);
  // Separate from acceptError: a peek failure (invalid/expired token) is fatal and replaces the whole
  // card, while an accept failure should stay on the same card with a retry option.
  const [peekError, setPeekError] = useState<string | null>(null);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declined, setDeclined] = useState(false);

  // Same "read window.location.search once on mount" pattern as reset-password.
  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  useEffect(() => {
    if (!token) return;
    api
      .get<InvitePeek>(`/v1/households/invite?token=${encodeURIComponent(token)}`)
      .then(setInvite)
      .catch((err) => setPeekError(err instanceof ApiError ? err.message : "Something went wrong. Please try again."));
  }, [token]);

  async function onAccept() {
    if (!token) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      await api.post<{ householdId: string }>("/v1/households/accept-invite", { token });
      setAccepted(true);
      setTimeout(() => router.push("/home"), 1500);
    } catch (err) {
      setAcceptError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setAccepting(false);
    }
  }

  async function onDecline() {
    if (!token) return;
    setDeclining(true);
    setAcceptError(null);
    try {
      await api.post("/v1/households/decline-invite", { token });
      setDeclined(true);
    } catch (err) {
      setAcceptError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setDeclining(false);
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
          <h1 className="text-lg font-semibold text-primary">You're in!</h1>
          <p className="text-sm text-secondary">You've joined {invite?.householdName}. Taking you to your home…</p>
        </CardBody>
      </Card>
    );
  }

  if (declined) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Invite declined</h1>
          <p className="text-sm text-secondary">You've declined the invite to join {invite?.householdName}.</p>
        </CardBody>
      </Card>
    );
  }

  if (!invite) return null;

  const redirectTo = `/accept-invite?token=${encodeURIComponent(token)}`;

  if (!user) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Join {invite.householdName}</h1>
          <p className="text-sm text-secondary">Sign in or create an account with {invite.invitedEmail} to accept this invite.</p>
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
            <Button variant="ghost" className="w-full" loading={declining} onClick={onDecline}>
              Decline invite
            </Button>
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
        <h1 className="text-lg font-semibold text-primary">Join {invite.householdName}</h1>
        <p className="text-sm text-secondary">You've been invited to join this household on Veynlo.</p>
        {acceptError && (
          <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
            {acceptError}
          </p>
        )}
        <Button className="w-full" loading={accepting} onClick={onAccept}>
          Accept invite
        </Button>
        <Button variant="ghost" className="w-full" loading={declining} onClick={onDecline}>
          Decline invite
        </Button>
      </CardBody>
    </Card>
  );
}
