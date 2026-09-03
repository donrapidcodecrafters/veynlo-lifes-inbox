"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { api, ApiError, API_BASE_URL } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";

export default function SignUpPage() {
  const router = useRouter();
  const t = useTranslations("auth.signUp");
  // §38.2 "Internationalization" — see sign-in/page.tsx's identical comment: the root-level
  // `LocaleProvider` calls `useSession()` on this pre-auth page too, caching a 401 that must be
  // invalidated before navigating away or the destination page's own `useSession()` reads stale data.
  const { refresh: refreshSession } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  // "Pre-launch private testing distribution" (docs/ROADMAP.md) — GET /v1/auth/config is public (no auth
  // needed) and exposes only the one boolean this page needs: whether to render the invite-code field at
  // all. Defaults to not-required so the field stays hidden while this call is still in flight, matching
  // this deployment's normal (flag-off) state rather than flashing an unnecessary field on every load.
  const [inviteRequired, setInviteRequired] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Same redirectTo pattern as sign-in — lets a page like accept-invite send someone here and get them
  // back afterward, with the invited email prefilled for convenience.
  // ONB-001 — a brand-new sign-up goes to onboarding first, not straight to Home; the (app) layout would
  // bounce it there anyway (see apps/web/src/app/(app)/layout.tsx), but starting here avoids that extra
  // redirect hop. An explicit `?redirectTo=` (e.g. from accept-invite) still wins below.
  const [redirectTo, setRedirectTo] = useState("/onboarding");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const target = params.get("redirectTo");
    if (target && target.startsWith("/") && !target.startsWith("//")) setRedirectTo(target);
    const prefillEmail = params.get("email");
    if (prefillEmail) setEmail(prefillEmail);
  }, []);

  useEffect(() => {
    api
      .get<{ signUpRequiresInvite: boolean }>("/v1/auth/config")
      .then((config) => setInviteRequired(config.signUpRequiresInvite))
      .catch(() => {
        // Leave the field hidden on failure — the backend still enforces the real requirement either way
        // (see the inline ApiError fallback below), so a failed config fetch is a degraded-UX, not a
        // security, gap.
      });
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api.post("/v1/auth/sign-up", { email, password, displayName, timezone, inviteCode: inviteCode.trim() || undefined });
      await refreshSession();
      router.push(redirectTo);
    } catch (err) {
      if (err instanceof ApiError) {
        // The backend's validation-error path (zod-validation.pipe.ts) always pairs a populated
        // `fieldErrors` with the exact same generic `message: "Request body failed validation."` —
        // never anything more specific. Showing that generic banner alongside the real, specific
        // field-level error (e.g. "String must contain at least 10 character(s)" right under Password)
        // was pure redundant noise: found live via a real sign-up submission with a too-short password,
        // both messages rendered stacked on top of each other. Only fall back to the banner when there's
        // no field-level error to explain the failure instead (e.g. INVITE_REQUIRED, rate limiting).
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
            <Label htmlFor="displayName">{t("nameLabel")}</Label>
            <Input
              id="displayName"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={fieldErrors.displayName?.[0]}
              required
            />
            <FieldError>{fieldErrors.displayName?.[0]}</FieldError>
          </div>
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
            <Label htmlFor="password">{t("passwordLabel")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password?.[0]}
              minLength={10}
              required
            />
            {fieldErrors.password?.[0] ? (
              <FieldError>{fieldErrors.password[0]}</FieldError>
            ) : (
              <p className="mt-1.5 text-sm text-tertiary">{t("passwordHint")}</p>
            )}
          </div>
          {inviteRequired && (
            <div>
              <Label htmlFor="inviteCode">{t("inviteCodeLabel")}</Label>
              <Input
                id="inviteCode"
                autoComplete="off"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                error={fieldErrors.inviteCode?.[0]}
                required
              />
              {fieldErrors.inviteCode?.[0] ? (
                <FieldError>{fieldErrors.inviteCode[0]}</FieldError>
              ) : (
                <p className="mt-1.5 text-sm text-tertiary">{t("inviteCodeHint")}</p>
              )}
            </div>
          )}
          {formError && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={loading}>
            {t("submit")}
          </Button>
          <p className="text-center text-xs text-tertiary">
            {t.rich("termsNotice", {
              terms: (chunks) => (
                <Link href="/terms" className="font-medium text-brand hover:underline">
                  {chunks}
                </Link>
              ),
              privacy: (chunks) => (
                <Link href="/privacy-policy" className="font-medium text-brand hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </form>
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border-subtle" />
          <span className="text-xs uppercase tracking-wide text-tertiary">{t("orDivider")}</span>
          <div className="h-px flex-1 bg-border-subtle" />
        </div>
        <div className="space-y-2">
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
        {t("haveAccount")}{" "}
        <Link href="/sign-in" className="font-medium text-brand hover:underline">
          {t("signIn")}
        </Link>
      </div>
    </Card>
  );
}
