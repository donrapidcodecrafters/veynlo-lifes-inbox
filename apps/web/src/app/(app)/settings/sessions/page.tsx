"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  platform: string | null;
  displayName: string | null;
  lastActiveAt: string | null;
  isCurrent: boolean;
}

interface PasskeyRow {
  id: string;
  createdAt: string;
}

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web browser",
  ios: "iPhone/iPad",
  android: "Android",
  macos: "macOS app",
  windows: "Windows app",
  extension: "Browser extension",
};

export default function SessionsPage() {
  const { data: sessions, mutate } = useSWR<SessionRow[]>("/v1/auth/sessions", swrFetcher);
  const { data: passkeys, mutate: mutatePasskeys } = useSWR<PasskeyRow[]>("/v1/auth/passkeys", swrFetcher);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [deletingPasskeyId, setDeletingPasskeyId] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/auth/sessions/${id}/revoke`);
      await mutate();
    } finally {
      setRevokingId(null);
    }
  }

  async function addPasskey() {
    setAddingPasskey(true);
    setPasskeyError(null);
    try {
      const options = await api.post<PublicKeyCredentialCreationOptionsJSON>("/v1/auth/passkeys/registration-options");
      const response = await startRegistration({ optionsJSON: options });
      await api.post("/v1/auth/passkeys/register", { response });
      await mutatePasskeys();
    } catch (err) {
      // A cancelled/dismissed browser prompt throws a WebAuthnError (name !== "ApiError"), not a real
      // failure worth showing — only a genuine server-side rejection or unexpected error gets a message.
      if (err instanceof ApiError) setPasskeyError(err.message);
      else if (err instanceof Error && err.name !== "AbortError" && err.name !== "NotAllowedError") {
        setPasskeyError("Couldn't add that passkey. Please try again.");
      }
    } finally {
      setAddingPasskey(false);
    }
  }

  async function deletePasskey(id: string) {
    setDeletingPasskeyId(id);
    try {
      await api.delete(`/v1/auth/passkeys/${id}`);
      await mutatePasskeys();
    } finally {
      setDeletingPasskeyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Devices &amp; sessions</h1>
        <p className="mt-1 text-sm text-tertiary">Everywhere you're currently signed in to Veynlo.</p>
      </header>

      <Card>
        <CardBody className="space-y-3">
          {!sessions && <p className="text-sm text-tertiary">Loading…</p>}
          {sessions?.map((s) => (
            <div
              key={s.id}
              className="flex flex-col gap-2 border-b border-border-subtle py-2 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-primary">
                    {s.displayName ?? PLATFORM_LABEL[s.platform ?? ""] ?? s.platform ?? "Unknown device"}
                  </p>
                  {s.isCurrent && <Badge tone="positive">This device</Badge>}
                </div>
                <p className="text-xs text-tertiary">
                  Signed in {new Date(s.createdAt).toLocaleDateString()} · last active{" "}
                  {s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleDateString() : new Date(s.lastSeenAt).toLocaleDateString()}
                </p>
              </div>
              {!s.isCurrent && (
                <Button variant="ghost" size="sm" className="shrink-0 whitespace-nowrap self-start" onClick={() => revoke(s.id)} disabled={revokingId === s.id}>
                  {revokingId === s.id ? "Signing out…" : "Sign out"}
                </Button>
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Passkeys</p>
              <p className="text-sm text-tertiary">Sign in with Face ID, Touch ID, or your device's screen lock — no password needed.</p>
            </div>
            <Button variant="secondary" size="sm" className="shrink-0 whitespace-nowrap self-start" onClick={addPasskey} loading={addingPasskey}>
              Add a passkey
            </Button>
          </div>
          {passkeyError && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {passkeyError}
            </p>
          )}
          {passkeys && passkeys.length === 0 && <p className="text-sm text-tertiary">No passkeys added yet.</p>}
          {passkeys?.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 border-t border-border-subtle pt-3 first:border-0 first:pt-0">
              <p className="text-sm text-secondary">Added {new Date(p.createdAt).toLocaleDateString()}</p>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 whitespace-nowrap"
                onClick={() => deletePasskey(p.id)}
                disabled={deletingPasskeyId === p.id}
              >
                {deletingPasskeyId === p.id ? "Removing…" : "Remove"}
              </Button>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
