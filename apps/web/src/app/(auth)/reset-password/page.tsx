"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";

export default function ResetPasswordPage() {
  const router = useRouter();
  // `undefined` = "haven't read window.location.search yet"; `null` = "read it, no token param" — these
  // must be distinct states. Initializing at `null` and setting `null` again for a genuinely tokenless URL
  // was a real bug: React bails out of a state update when the new value is `Object.is`-equal to the
  // current one, so `setToken(null)` when already `null` never re-renders, permanently stranding the page
  // on the "still loading" branch below instead of ever reaching the "invalid link" one.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [newPassword, setNewPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // Same "read from window.location.search directly" pattern as the sign-in page's OAuth-error handling
  // — avoids needing a Suspense boundary around a `useSearchParams()` call for a value that's only ever
  // read once, on mount.
  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setFormError(null);
    setFieldErrors({});
    setTokenInvalid(false);
    try {
      await api.post("/v1/auth/reset-password", { token, newPassword });
      setDone(true);
      setTimeout(() => router.push("/sign-in"), 2000);
    } catch (err) {
      setTokenInvalid(err instanceof ApiError && err.code === "INVALID_RESET_TOKEN");
      if (err instanceof ApiError) {
        // Same fix as sign-in/sign-up's identical catch block — the backend's validation-error path
        // always pairs a populated `fieldErrors` with the exact same generic "Request body failed
        // validation." message, never anything more specific, so showing both (confirmed live: a
        // too-short new password rendered the specific "String must contain at least 10 character(s)"
        // right under the field AND the generic banner below it) was redundant noise.
        if (err.fieldErrors && Object.keys(err.fieldErrors).length > 0) setFieldErrors(err.fieldErrors);
        else setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (token === undefined) {
    // Still reading window.location.search on first render (client-only) — avoids a flash of the
    // "invalid link" state before the token's actually been checked.
    return null;
  }

  if (!token) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Invalid reset link</h1>
          <p className="text-sm text-secondary">This link is missing its reset token. Request a new one below.</p>
          <Link href="/forgot-password" className="text-sm font-medium text-brand hover:underline">
            Request a new link
          </Link>
        </CardBody>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Password reset</h1>
          <p className="text-sm text-secondary">Your password has been changed. Redirecting you to sign in…</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <h1 className="text-lg font-semibold text-primary">Choose a new password</h1>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="newPassword">New password</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={10}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              error={fieldErrors.newPassword?.[0]}
              required
            />
            <FieldError>{fieldErrors.newPassword?.[0]}</FieldError>
          </div>
          {formError && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {formError}{" "}
              {tokenInvalid && (
                <Link href="/forgot-password" className="underline">
                  Request a new link
                </Link>
              )}
            </p>
          )}
          <Button type="submit" className="w-full" loading={loading}>
            Reset password
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
