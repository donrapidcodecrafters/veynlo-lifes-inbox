"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface PasskeyRow {
  id: string;
  label: string | null;
  deviceType: string | null;
  backedUp: boolean | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface SessionRow {
  id: string;
  deviceId: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  platform: string | null;
  displayName: string | null;
  isCurrent: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web browser",
  ios: "iPhone/iPad",
  android: "Android",
  macos: "Mac",
  windows: "Windows",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A best-effort client-side nickname for a newly-registered passkey (e.g. "Chrome on macOS") — cosmetic
 * only, shown in the "Manage your passkeys" list below; never used for anything security-relevant. */
function guessDeviceLabel(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "this device";
  return `${browser} on ${os}`;
}

export default function SecuritySettingsPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const { data: sessions, isLoading, mutate } = useSWR<SessionRow[]>("/v1/auth/sessions", swrFetcher);
  const { data: passkeys, mutate: mutatePasskeys } = useSWR<PasskeyRow[]>("/v1/auth/passkeys", swrFetcher);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [removingPasskeyId, setRemovingPasskeyId] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  /**
   * AUTH-001 "create passkey" — the registration ceremony: fetch a challenge, let the browser create a
   * real WebAuthn credential (opens the platform's native passkey UI/Face-ID/Touch-ID prompt), then send
   * the attestation back for real cryptographic verification (PasskeyService.verifyRegistration).
   */
  async function addPasskey() {
    setAddingPasskey(true);
    setPasskeyError(null);
    try {
      const { options, challengeToken } = await api.post<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }>(
        "/v1/auth/passkeys/registration-options",
      );
      const response = await startRegistration({ optionsJSON: options });
      await api.post("/v1/auth/passkeys/registration-verify", { response, challengeToken, label: guessDeviceLabel() });
      mutatePasskeys();
    } catch (err) {
      if (err instanceof ApiError) setPasskeyError(err.message);
      else if (err instanceof Error && err.name === "NotAllowedError") {
        // User cancelled the native passkey prompt — not a real error.
      } else setPasskeyError("Couldn't add that passkey. Please try again.");
    } finally {
      setAddingPasskey(false);
    }
  }

  async function removePasskey(id: string) {
    setRemovingPasskeyId(id);
    setPasskeyError(null);
    try {
      await api.delete(`/v1/auth/passkeys/${id}`);
      mutatePasskeys();
    } catch (err) {
      setPasskeyError(err instanceof ApiError ? err.message : "Couldn't remove that passkey. Please try again.");
    } finally {
      setRemovingPasskeyId(null);
    }
  }

  const active = (sessions ?? []).filter((s) => !s.revokedAt).sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

  async function revoke(sessionId: string) {
    setRevokingId(sessionId);
    setError(null);
    try {
      await api.post(`/v1/auth/sessions/${sessionId}/revoke`);
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't sign out that device. Please try again.");
    } finally {
      setRevokingId(null);
    }
  }

  async function signOutEverywhere() {
    if (!window.confirm("Sign out of every device, including this one?")) return;
    setSigningOutEverywhere(true);
    try {
      await api.post("/v1/auth/sign-out-everywhere");
      await refresh();
      router.push("/sign-in");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSigningOutEverywhere(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Security</h1>
        <p className="mt-1 text-sm text-tertiary">Everywhere you're currently signed in. Sign out of a device you don't recognize.</p>
      </header>

      {error && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {error}
        </p>
      )}

      {!isLoading && active.length === 0 && <p className="text-sm text-tertiary">No active sessions.</p>}

      {active.length > 0 && (
        <ul className="space-y-3">
          {active.map((s) => (
            <li key={s.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[0.9375rem] font-medium text-primary">
                      {s.displayName || (s.platform && PLATFORM_LABEL[s.platform]) || "Unknown device"}
                      {s.isCurrent && <Badge tone="info">This device</Badge>}
                    </p>
                    <p className="text-sm text-tertiary">Last active {formatWhen(s.lastSeenAt)}</p>
                  </div>
                  <Button variant="secondary" size="sm" loading={revokingId === s.id} onClick={() => revoke(s.id)}>
                    Sign out
                  </Button>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border-subtle pt-4">
        <Badge tone="warning">All devices</Badge>
        <p className="mt-2 mb-3 text-sm text-tertiary">Sign out everywhere at once, including this device.</p>
        <Button variant="critical" loading={signingOutEverywhere} onClick={signOutEverywhere}>
          Sign out everywhere
        </Button>
      </div>

      {/* AUTH-001 "create passkey" / "add/remove sign-in method" — a passkey is phishing-resistant (no
          password to steal or reuse) and doesn't require any third-party account, unlike Google/Microsoft/
          Apple sign-in. */}
      <div className="border-t border-border-subtle pt-4">
        <h2 className="text-lg font-semibold text-primary">Passkeys</h2>
        <p className="mt-1 mb-3 text-sm text-tertiary">Sign in with Face ID, Touch ID, or your device's screen lock — no password to remember or steal.</p>

        {passkeyError && (
          <p role="alert" className="mb-3 rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
            {passkeyError}
          </p>
        )}

        {passkeys && passkeys.length === 0 && <p className="mb-3 text-sm text-tertiary">No passkeys yet.</p>}

        {passkeys && passkeys.length > 0 && (
          <ul className="mb-3 space-y-3">
            {passkeys.map((p) => (
              <li key={p.id}>
                <Card>
                  <CardBody className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[0.9375rem] font-medium text-primary">{p.label || "Passkey"}</p>
                      <p className="text-sm text-tertiary">{p.lastUsedAt ? `Last used ${formatWhen(p.lastUsedAt)}` : `Added ${formatWhen(p.createdAt)}`}</p>
                    </div>
                    <Button variant="secondary" size="sm" loading={removingPasskeyId === p.id} onClick={() => removePasskey(p.id)}>
                      Remove
                    </Button>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}

        <Button variant="secondary" loading={addingPasskey} onClick={addPasskey}>
          Add a passkey
        </Button>
      </div>
    </div>
  );
}
