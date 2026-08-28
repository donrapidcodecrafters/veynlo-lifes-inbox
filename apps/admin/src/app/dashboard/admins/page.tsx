"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { api, ApiError, swrFetcher } from "@/lib/api-client";
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
    <section className="rounded-xl border border-border-subtle bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export default function AdminsPage() {
  const { admin: currentAdmin } = useAdminSession();
  const { data: admins, mutate } = useSWR<AdminAccount[]>("/v1/admin/admins", swrFetcher);

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
      setCreateError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/v1/admin/admins/${id}/revoke`);
      await mutate();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Revoke failed.");
    } finally {
      setBusyId(null);
    }
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
        {!admins && <p className="text-sm text-tertiary">Loading…</p>}
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
                          onClick={() => onRevoke(a.id)}
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
