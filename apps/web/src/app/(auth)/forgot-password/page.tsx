"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setFormError(null);
    setFieldErrors({});
    try {
      // Deliberately shows the same success state regardless of what the server actually did — the API
      // itself never reveals whether the email matched a real account (see
      // IdentityService.forgotPassword's doc comment), so the UI must not either.
      await api.post("/v1/auth/forgot-password", { email });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError) {
        // Same fix as sign-in/sign-up's identical catch block — the backend's validation-error path
        // always pairs a populated `fieldErrors` with the exact same generic "Request body failed
        // validation." message, never anything more specific, so showing both was redundant noise.
        if (err.fieldErrors && Object.keys(err.fieldErrors).length > 0) setFieldErrors(err.fieldErrors);
        else setFormError(err.message);
      } else {
        setFormError("Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Check your email</h1>
          <p className="text-sm text-secondary">
            If <strong>{email}</strong> is a Veynlo account, we&apos;ve sent a link to reset your password. It expires in
            1 hour.
          </p>
          <Link href="/sign-in" className="text-sm font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <h1 className="text-lg font-semibold text-primary">Reset your password</h1>
        <p className="text-sm text-secondary">Enter your account&apos;s email and we&apos;ll send you a link to reset your password.</p>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="email">Email</Label>
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
          {formError && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {formError}
            </p>
          )}
          <Button type="submit" className="w-full" loading={loading}>
            Send reset link
          </Button>
        </form>
      </CardBody>
      <div className="border-t border-border-subtle px-6 py-4 text-center text-sm text-secondary">
        <Link href="/sign-in" className="font-medium text-brand hover:underline">
          Back to sign in
        </Link>
      </div>
    </Card>
  );
}
