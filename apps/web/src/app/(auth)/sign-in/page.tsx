"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startAuthentication, browserSupportsWebAuthn, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { api, ApiError, API_BASE_URL } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";

// Keyed by the lowercased `code` field of whatever exception the OAuth callback threw — see
// identity.controller.ts's oauthErrorRedirect.
const OAUTH_ERROR_MESSAGE: Record<string, string> = {
  oauth_not_configured: "That sign-in method isn't configured on this deployment yet.",
  email_already_registered: "An account with this email already exists. Sign in with your email and password instead.",
  oauth_failed: "Couldn't complete that sign-in. Please try again.",
};

export default function SignInPage() {
  const router = useRouter();
  const t = useTranslations("auth.signIn");
  // §38.2 "Internationalization" — the new root-level `LocaleProvider` (src/i18n/provider.tsx) calls
  // `useSession()` on every page, including this pre-auth one, to resolve the signed-in user's locale
  // preference. That means the SWR cache for "/v1/auth/me" already holds a cached 401 by the time a
  // visitor here actually signs in; without forcing a revalidation before navigating away, AppLayout's
  // own `useSession()` call on the destination page reads that stale cached 401 (SWR's dedupingInterval
  // suppresses a fresh fetch) and immediately bounces back here — found live via a real Playwright run
  // of this exact flow. `refresh()` mirrors `apps/admin`'s own sign-in page, which already documents
  // this identical stale-cache class of bug for its own `useAdminSession()`.
  const { refresh: refreshSession } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // AUTH-001 "Sign in with a passkey" — browserSupportsWebAuthn() reads `window.PublicKeyCredential`,
  // which doesn't exist during Next.js's server render, so this starts false and flips true in the
  // effect below rather than being computed inline (which would mismatch between server and client HTML).
  const [passkeySupported, setPasskeySupported] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  // Read once on mount, same "avoid a Suspense boundary for a useSearchParams() read" pattern as
  // reset-password — lets a page like accept-invite send someone here and get them back afterward
  // (e.g. `/sign-in?redirectTo=/accept-invite%3Ftoken%3D...`).
  const [redirectTo, setRedirectTo] = useState("/home");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) {
      setFormError(OAUTH_ERROR_MESSAGE[error] ?? "Couldn't complete that sign-in. Please try again.");
      window.history.replaceState(null, "", window.location.pathname);
    }
    // startsWith("/") alone would still allow a protocol-relative "//evil.com" open redirect, so also
    // reject a second leading slash.
    const target = params.get("redirectTo");
    if (target && target.startsWith("/") && !target.startsWith("//")) setRedirectTo(target);
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);

  /**
   * AUTH-001 "Sign in with a passkey" — a genuine discoverable-credential ("usernameless") flow: no email
   * is collected first, `POST /v1/auth/passkeys/authentication-options` is called with no body, and the
   * browser lets the user pick from whichever passkeys it already has for this site. `startAuthentication`
   * is the one call in this handler that can't be a plain fetch — it's what actually opens the
   * platform's native passkey picker/Face-ID/Touch-ID prompt via `navigator.credentials.get()`.
   */
  async function onPasskeySignIn() {
    setPasskeyLoading(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const { options, challengeToken } = await api.post<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }>(
        "/v1/auth/passkeys/authentication-options",
        {},
      );
      const response = await startAuthentication({ optionsJSON: options });
      await api.post("/v1/auth/passkeys/authentication-verify", { response, challengeToken });
      await refreshSession();
      router.push(redirectTo);
    } catch (err) {
      if (err instanceof ApiError) setFormError(err.message);
      else if (err instanceof Error && err.name === "NotAllowedError") {
        // The user cancelled the native passkey prompt, or it timed out — not a real error worth alarming
        // over, same "quiet cancel" treatment a cancelled file picker or share sheet gets elsewhere.
      } else setFormError(t("passkeyError"));
    } finally {
      setPasskeyLoading(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    setFieldErrors({});
    try {
      await api.post("/v1/auth/sign-in", { email, password });
      await refreshSession();
      router.push(redirectTo);
    } catch (err) {
      if (err instanceof ApiError) {
        // Same fix as sign-up's identical catch block — the backend's validation-error path always pairs
        // a populated `fieldErrors` with the exact same generic "Request body failed validation."
        // message, never anything more specific, so showing both was redundant noise. Only fall back to
        // the banner when there's no field-level error to explain the failure (e.g. "Incorrect email or
        // password.", which has no fieldErrors at all).
        if (err.fieldErrors && Object.keys(err.fieldErrors).length > 0) setFieldErrors(err.fieldErrors);
        else setFormError(err.message);
      } else {
        setFormError(t("genericError"));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <h1 className="text-lg font-semibold text-primary">{t("title")}</h1>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="email">{t("emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={fieldErrors.email?.[0]}
              required
            />
            <FieldError>{fieldErrors.email?.[0]}</FieldError>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t("passwordLabel")}</Label>
              <Link href="/forgot-password" className="text-xs font-medium text-brand hover:underline">
                {t("forgotPassword")}
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password?.[0]}
              required
            />
            <FieldError>{fieldErrors.password?.[0]}</FieldError>
          </div>
          {formError && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={loading}>
            {t("submit")}
          </Button>
        </form>
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border-subtle" />
          <span className="text-xs uppercase tracking-wide text-tertiary">{t("orDivider")}</span>
          <div className="h-px flex-1 bg-border-subtle" />
        </div>
        <div className="space-y-2">
          {passkeySupported && (
            <Button variant="secondary" className="w-full" loading={passkeyLoading} onClick={onPasskeySignIn}>
              {t("passkey")}
            </Button>
          )}
          <Button variant="secondary" className="w-full" onClick={() => (window.location.href = `${API_BASE_URL}/v1/auth/google/authorize`)}>
            {t("continueWithGoogle")}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => (window.location.href = `${API_BASE_URL}/v1/auth/microsoft/authorize`)}>
            {t("continueWithMicrosoft")}
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => (window.location.href = `${API_BASE_URL}/v1/auth/apple/authorize`)}>
            {t("continueWithApple")}
          </Button>
        </div>
      </CardBody>
      <div className="border-t border-border-subtle px-6 py-4 text-center text-sm text-secondary">
        {t("noAccount")}{" "}
        <Link href="/sign-up" className="font-medium text-brand hover:underline">
          {t("createAccount")}
        </Link>
      </div>
    </Card>
  );
}
