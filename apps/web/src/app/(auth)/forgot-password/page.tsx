"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api-client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/v1/auth/forgot-password", { email });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <h1 className="text-lg font-semibold text-primary">Check your email</h1>
          <p className="text-sm text-secondary">
            If an account exists for {email}, a password reset link is on its way. It expires in 1 hour.
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
        <div>
          <h1 className="text-lg font-semibold text-primary">Reset your password</h1>
          <p className="mt-1 text-sm text-tertiary">Enter your email and we&apos;ll send you a reset link.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {error}
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
