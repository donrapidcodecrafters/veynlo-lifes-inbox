"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { api, ApiError, apiErrorMessage, swrFetcher } from "@/lib/api-client";
import { useAdminSession } from "@/hooks/use-admin-session";

interface AdminAccount {
  id: string;
  email: string;
  displayName: string;
  role: "support" | "superadmin";
  createdAt: string;
  lastLoginAt: string | null;
  revokedAt: string | null;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-x-auto rounded-xl border border-border-subtle bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export default function AdminsPage() {
  const { admin: currentAdmin, isLoading: sessionLoading } = useAdminSession();
  const { data: admins, error: adminsError, mutate } = useSWR<AdminAccount[]>("/v1/admin/admins", swrFetcher);

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"support" | "superadmin">("support");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdCredential, setCreatedCredential] = useState<{ email: string; temporaryPassword: string } | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    // Bug fix: found live by submitting a duplicate email right after a successful create — the prior
    // success left `createdCredential` set, and this catch block never cleared it, so a FAILED attempt
    // rendered "An admin account already exists for this email." directly above the previous attempt's
    // still-visible "Account created for ... Share this temporary password now" panel. That reads as if
    // the failed submission just generated a new password, when it's actually the old one from the last
    // successful create. Clearing it up front means a failed attempt only ever shows the error.
    setCreatedCredential(null);
    try {
      const result = await api.post<{ id: string; temporaryPassword: string }>("/v1/admin/admins", {
        email,
        displayName,
        role,
      });
      setCreatedCredential({ email, temporaryPassword: result.temporaryPassword });
      setEmail("");
      setDisplayName("");
      setRole("support");
      await mutate();
    } catch (err) {
      setCreateError(apiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  // Bug fix: found live — clicking this button revoked the target admin's console access immediately,
  // with no confirmation step at all. Every comparably destructive action in the sibling web app (leave
  // household, remove member, revoke a household invite, sign out everywhere — see apps/web's settings
  // pages) is gated behind a window.confirm(); this one-click, no-undo action locking a real colleague out
  // of the admin console was the only destructive action in this app missing that same guard.
  async function onRevoke(id: string, displayName: string) {
    if (!window.confirm(`Revoke ${displayName}'s admin access? They'll immediately lose access to the admin console.`)) return;
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/v1/admin/admins/${id}/revoke`);
      await mutate();
    } catch (err) {
      setActionError(apiErrorMessage(err, "Revoke failed."));
    } finally {
      setBusyId(null);
    }
  }

  // This whole page is superadmin-only server-side (SuperAdminGuard) — the nav link is already hidden for
  // a support admin, but nothing stopped one from navigating here directly, seeing a fully interactive
  // "Create admin" form, and getting a table stuck on "Loading…" forever (the underlying 403 was never
  // surfaced). Client-side, this is only a UX guard, not the real security boundary — the actual
  // enforcement is the backend 403 either way — but a support admin should see a clear, honest message
  // instead of a broken-looking page.
  if (!sessionLoading && currentAdmin && currentAdmin.role !== "superadmin") {
    return (
      <Section title="Access restricted">
        <p className="text-sm text-tertiary">Managing other admin accounts requires the superadmin role.</p>
      </Section>
    );
  }

  return (
    <div className="space-y-6">
      <Section title="Create admin">
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10 w-64 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Name</span>
            <input
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="h-10 w-52 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "support" | "superadmin")}
              className="h-10 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
            >
              <option value="support">support</option>
              <option value="superadmin">superadmin</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={creating}
            className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            Create
          </button>
        </form>
        {createError && <p className="mt-3 text-sm text-critical-subtle-text">{createError}</p>}
        {createdCredential && (
          <div className="mt-4 rounded-lg bg-subtle p-3 text-sm">
            <p className="font-medium text-primary">
              Account created for {createdCredential.email}. Share this temporary password now — it will not be shown again:
            </p>
            <p className="mt-1 font-mono text-base text-primary">{createdCredential.temporaryPassword}</p>
          </div>
        )}
      </Section>

      <Section title="All admins">
        {actionError && <p className="mb-3 text-sm text-critical-subtle-text">{actionError}</p>}
        {adminsError && (
          <p className="flex items-center gap-3 text-sm text-critical-subtle-text">
            {adminsError instanceof ApiError ? adminsError.message : "Couldn't load admin accounts."}
            <button onClick={() => mutate()} className="font-medium underline underline-offset-2">
              Retry
            </button>
          </p>
        )}
        {!admins && !adminsError && <p className="text-sm text-tertiary">Loading…</p>}
        {admins && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Role</th>
                <th className="pb-2 font-medium">Last login</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => {
                const isSelf = a.id === currentAdmin?.id;
                return (
                  <tr key={a.id} className="border-t border-border-subtle">
                    <td className="py-2 text-primary">{a.displayName}</td>
                    <td className="py-2 text-tertiary">{a.email}</td>
                    <td className="py-2 text-tertiary">{a.role}</td>
                    <td className="py-2 text-tertiary">{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : "never"}</td>
                    <td className="py-2">
                      {a.revokedAt ? <span className="text-critical">revoked</span> : <span className="text-positive">active</span>}
                    </td>
                    <td className="py-2">
                      {!a.revokedAt && !isSelf && (
                        <button
                          disabled={busyId === a.id}
                          onClick={() => onRevoke(a.id, a.displayName)}
                          className="rounded-lg border border-border-default px-2.5 py-1 text-xs font-medium text-secondary hover:bg-subtle disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
