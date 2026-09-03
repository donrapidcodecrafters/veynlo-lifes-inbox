"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { api, ApiError, apiErrorMessage, swrFetcher } from "@/lib/api-client";

interface SignupInvite {
  id: string;
  email: string | null;
  redeemedAt: string | null;
  redeemedByUserId: string | null;
  createdByAdminId: string;
  createdAt: string;
  expiresAt: string | null;
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

function inviteStatus(invite: SignupInvite): { label: string; className: string } {
  if (invite.revokedAt) return { label: "revoked", className: "text-critical" };
  if (invite.redeemedAt) return { label: "redeemed", className: "text-tertiary" };
  if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) return { label: "expired", className: "text-critical" };
  return { label: "active", className: "text-positive" };
}

export default function InvitesPage() {
  const { data: invites, error: invitesError, mutate } = useSWR<SignupInvite[]>("/v1/admin/invites", swrFetcher);

  const [email, setEmail] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<{ email: string | null; code: string; expiresAt: string | null } | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    // Bug fix: same issue as dashboard/admins' onCreate — without clearing this, a failed create right
    // after a successful one left the previous invite's "Share this code now" panel (with its still-valid
    // code) visible directly above the new error, misleadingly implying the failed submission was the one
    // that produced that code.
    setCreatedInvite(null);
    try {
      const days = expiresInDays.trim() ? Number(expiresInDays.trim()) : undefined;
      const result = await api.post<{ id: string; code: string; email: string | null; expiresAt: string | null }>("/v1/admin/invites", {
        email: email.trim() || undefined,
        expiresInDays: days,
      });
      setCreatedInvite({ email: result.email, code: result.code, expiresAt: result.expiresAt });
      setEmail("");
      setExpiresInDays("");
      await mutate();
    } catch (err) {
      setCreateError(apiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  // Bug fix: same gap as dashboard/admins' onRevoke — this fired immediately with no confirmation step,
  // unlike every comparable destructive action in the sibling web app's settings pages (leave household,
  // revoke a household invite, etc.), which all confirm first. A revoked invite's code stops working
  // immediately for whoever it was meant for, with no undo — worth a confirm like the rest.
  async function onRevoke(id: string, email: string | null) {
    if (!window.confirm(`Revoke the invite${email ? ` for ${email}` : ""}? The code will stop working immediately.`)) return;
    setBusyId(id);
    setActionError(null);
    try {
      await api.post(`/v1/admin/invites/${id}/revoke`);
      await mutate();
    } catch (err) {
      setActionError(apiErrorMessage(err, "Revoke failed."));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Section title="Create invite">
        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Email (optional — leave blank for any email)</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tester@example.com"
              className="h-10 w-64 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-tertiary">Expires in (days, optional)</span>
            <input
              type="number"
              min={1}
              max={365}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              placeholder="never"
              className="h-10 w-32 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
            />
          </label>
          <button
            type="submit"
            disabled={creating}
            className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            Generate invite
          </button>
        </form>
        {createError && <p className="mt-3 text-sm text-critical-subtle-text">{createError}</p>}
        {createdInvite && (
          <div className="mt-4 rounded-lg bg-subtle p-3 text-sm">
            <p className="font-medium text-primary">
              Invite created{createdInvite.email ? ` for ${createdInvite.email}` : " (any email can redeem it)"}. Share this code now
              — it will not be shown again:
            </p>
            <p className="mt-1 font-mono text-lg tracking-wider text-primary">{createdInvite.code}</p>
            <button
              // Bug fix: found live — `navigator.clipboard.writeText` returns a promise that rejects
              // whenever the browser denies clipboard access (no user-activation heuristic met, a
              // permissions-policy block, etc.), and with no `.catch` here that surfaced as an unhandled
              // promise rejection (visible in Next's dev error overlay) for a click that otherwise looks
              // like it did nothing — no in-app error, no visible failure. Silently ignored: a copy button
              // failing isn't worth interrupting the admin's flow over, but it shouldn't crash either.
              onClick={() => navigator.clipboard?.writeText(createdInvite.code).catch(() => {})}
              className="mt-2 rounded-lg border border-border-default px-2.5 py-1 text-xs font-medium text-secondary hover:bg-surface"
            >
              Copy code
            </button>
            <button
              onClick={() => setCreatedInvite(null)}
              className="mt-2 ml-2 rounded-lg border border-border-default px-2.5 py-1 text-xs font-medium text-secondary hover:bg-surface"
            >
              Dismiss
            </button>
          </div>
        )}
      </Section>

      <Section title="All invites">
        {actionError && <p className="mb-3 text-sm text-critical-subtle-text">{actionError}</p>}
        {invitesError && (
          <p className="flex items-center gap-3 text-sm text-critical-subtle-text">
            {invitesError instanceof ApiError ? invitesError.message : "Couldn't load invites."}
            <button onClick={() => mutate()} className="font-medium underline underline-offset-2">
              Retry
            </button>
          </p>
        )}
        {!invites && !invitesError && <p className="text-sm text-tertiary">Loading…</p>}
        {invites && invites.length === 0 && <p className="text-sm text-tertiary">No invites created yet.</p>}
        {invites && invites.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 font-medium">Created</th>
                <th className="pb-2 font-medium">Expires</th>
                <th className="pb-2 font-medium">Redeemed</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => {
                const status = inviteStatus(invite);
                const revocable = !invite.revokedAt && !invite.redeemedAt;
                return (
                  <tr key={invite.id} className="border-t border-border-subtle">
                    <td className="py-2 text-primary">{invite.email ?? <span className="text-tertiary">any email</span>}</td>
                    <td className="py-2 text-tertiary">{new Date(invite.createdAt).toLocaleString()}</td>
                    <td className="py-2 text-tertiary">{invite.expiresAt ? new Date(invite.expiresAt).toLocaleString() : "never"}</td>
                    <td className="py-2 text-tertiary">{invite.redeemedAt ? new Date(invite.redeemedAt).toLocaleString() : "—"}</td>
                    <td className={`py-2 ${status.className}`}>{status.label}</td>
                    <td className="py-2">
                      {revocable && (
                        <button
                          disabled={busyId === invite.id}
                          onClick={() => onRevoke(invite.id, invite.email)}
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
