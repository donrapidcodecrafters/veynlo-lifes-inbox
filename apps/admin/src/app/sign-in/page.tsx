"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";

export default function AdminSignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/v1/admin/auth/sign-in", { email, password });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[380px] rounded-xl border border-border-subtle bg-surface p-6 shadow-sm">
        <div className="mb-6">
          <p className="text-lg font-semibold text-primary">Veynlo Admin</p>
          <p className="mt-1 text-sm text-tertiary">Internal support console — audited access only.</p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-secondary">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 w-full rounded-lg border border-border-default bg-surface px-3.5 text-[0.9375rem] text-primary"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-secondary">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10 w-full rounded-lg border border-border-default bg-surface px-3.5 text-[0.9375rem] text-primary"
            />
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="h-10 w-full rounded-lg bg-brand text-[0.9375rem] font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="mt-4 text-xs text-tertiary">
          No account? Operator accounts are provisioned by an existing superadmin via the{" "}
          <code className="rounded bg-subtle px-1 py-0.5">create-admin</code> script.
        </p>
      </div>
    </div>
  );
}
