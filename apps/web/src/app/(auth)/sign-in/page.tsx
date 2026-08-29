"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { api, ApiError, API_BASE_URL } from "@/lib/api-client";

// Keyed by the lowercased `code` field of whatever exception the OAuth callback threw — see
// identity.controller.ts's oauthErrorRedirect.
const OAUTH_ERROR_MESSAGE: Record<string, string> = {
  oauth_not_configured: "That sign-in method isn't configured on this deployment yet.",
  email_already_registered: "An account with this email already exists. Sign in with your email and password instead.",
  oauth_failed: "Couldn't complete that sign-in. Please try again.",
};

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [passkeyAvailable, setPasskeyAvailable] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) {
      setFormError(OAUTH_ERROR_MESSAGE[error] ?? "Couldn't complete that sign-in. Please try again.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    setPasskeyAvailable(browserSupportsWebAuthn());
  }, []);

  async function onPasskeySignIn() {
    setPasskeyLoading(true);
    setFormError(null);
    try {
      const { attemptId, options } = await api.post<{ attemptId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
        "/v1/auth/passkeys/authentication-options",
      );
      const response = await startAuthentication({ optionsJSON: options });
      await api.post("/v1/auth/passkeys/authenticate", { attemptId, response });
      router.push("/home");
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
      else if (err instanceof Error && err.name !== "AbortError" && err.name !== "NotAllowedError") {
        setFormError("Couldn't sign in with that passkey. Please try again.");
      }
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    try {
      await api.post("/v1/auth/sign-in", { email, password });
      router.push("/home");
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <h1 className="text-lg font-semibold text-primary">Welcome back</h1>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link href="/forgot-password" className="text-xs font-medium text-brand hover:underline">
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {formError && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={loading}>
            Sign in
          </Button>
        </form>
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border-subtle" />
          <span className="text-xs uppercase tracking-wide text-tertiary">or</span>
          <div className="h-px flex-1 bg-border-subtle" />
        </div>
        <div className="space-y-2">
          {passkeyAvailable && (
            <Button variant="secondary" className="w-full" onClick={onPasskeySignIn} loading={passkeyLoading}>
              Sign in with a passkey
            </Button>
          )}
          <Button variant="secondary" className="w-full" onClick={() => (window.location.href = `${API_BASE_URL}/v1/auth/google/authorize`)}>
            Continue with Google
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => (window.location.href = `${API_BASE_URL}/v1/auth/microsoft/authorize`)}>
            Continue with Microsoft
          </Button>
        </div>
      </CardBody>
      <div className="border-t border-border-subtle px-6 py-4 text-center text-sm text-secondary">
        New to Veynlo?{" "}
        <Link href="/sign-up" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </div>
    </Card>
  );
}
