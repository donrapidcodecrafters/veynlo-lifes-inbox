"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, ApiError, swrFetcher } from "@/lib/api-client";

interface UserLookupResult {
  id: string;
  email: string | null;
  status: string;
  createdAt: string;
  connections: Array<{ id: string; provider: string; health: string; lastSuccessfulSyncAt: string | null }>;
  entitlements: Array<{ id: string; planKey: string; source: string; effectiveFrom: string; effectiveTo: string | null; reason: string | null }>;
}

const ADMIN_MANAGEABLE_SOURCES = new Set(["support_granted", "promotional", "grandfathered", "referral", "partner_sponsored"]);
const PLAN_KEYS = ["free", "plus", "family", "pro_agent"] as const;

interface ConnectorHealthSummary {
  total: number;
  byHealth: Record<string, number>;
}

interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  result: string;
  occurredAt: string;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border-subtle bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export default function DashboardPage() {
  const [email, setEmail] = useState("");
  const [lookupResult, setLookupResult] = useState<UserLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [grantPlanKey, setGrantPlanKey] = useState<(typeof PLAN_KEYS)[number]>("plus");
  const [grantReason, setGrantReason] = useState("");
  const [grantDurationDays, setGrantDurationDays] = useState("");
  const [grantError, setGrantError] = useState<string | null>(null);
  const [grantSubmitting, setGrantSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const { data: health } = useSWR<ConnectorHealthSummary>("/v1/admin/connectors/health", swrFetcher, {
    refreshInterval: 30_000,
  });
  const { data: auditEvents } = useSWR<AuditEvent[]>("/v1/admin/audit-events", swrFetcher, { refreshInterval: 15_000 });

  async function runLookup() {
    if (!email.trim()) return;
    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const result = await api.get<UserLookupResult | null>(`/v1/admin/users/lookup?email=${encodeURIComponent(email)}`);
      if (!result) setLookupError("No user found with that email.");
      else setLookupResult(result);
    } catch (err) {
      setLookupError(err instanceof ApiError ? err.message : "Lookup failed.");
    } finally {
      setLookupLoading(false);
    }
  }

  async function reRunLookup() {
    if (!lookupResult?.email) return;
    const result = await api.get<UserLookupResult | null>(`/v1/admin/users/lookup?email=${encodeURIComponent(lookupResult.email)}`);
    setLookupResult(result);
  }

  async function grantEntitlement() {
    if (!lookupResult || !grantReason.trim()) return;
    setGrantSubmitting(true);
    setGrantError(null);
    try {
      await api.post(`/v1/admin/users/${lookupResult.id}/entitlements`, {
        planKey: grantPlanKey,
        reason: grantReason,
        durationDays: grantDurationDays ? Number(grantDurationDays) : null,
      });
      setGrantReason("");
      setGrantDurationDays("");
      await reRunLookup();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't grant that entitlement.");
    } finally {
      setGrantSubmitting(false);
    }
  }

  async function revokeEntitlement(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/admin/entitlements/${id}/revoke`);
      await reRunLookup();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't revoke that entitlement.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Section title="User lookup">
        <div className="flex gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runLookup()}
            placeholder="user@example.com"
            className="h-10 flex-1 rounded-lg border border-border-default bg-surface px-3.5 text-sm text-primary"
          />
          <button
            onClick={runLookup}
            disabled={lookupLoading}
            className="h-10 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            {lookupLoading ? "Looking up…" : "Look up"}
          </button>
        </div>
        {lookupError && <p className="mt-3 text-sm text-critical-subtle-text">{lookupError}</p>}
        {lookupResult && (
          <div className="mt-4 space-y-3 border-t border-border-subtle pt-4 text-sm">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-tertiary">Status</p>
                <p className="font-medium text-primary">{lookupResult.status}</p>
              </div>
              <div>
                <p className="text-xs text-tertiary">Created</p>
                <p className="font-medium text-primary">{new Date(lookupResult.createdAt).toLocaleDateString()}</p>
              </div>
              <div>
                <p className="text-xs text-tertiary">Plan</p>
                <p className="font-medium text-primary">{lookupResult.entitlements[0]?.planKey ?? "free"}</p>
              </div>
              <div>
                <p className="text-xs text-tertiary">Connections</p>
                <p className="font-medium text-primary">{lookupResult.connections.length}</p>
              </div>
            </div>
            {lookupResult.connections.length > 0 && (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-tertiary">
                    <th className="pb-2 font-medium">Provider</th>
                    <th className="pb-2 font-medium">Health</th>
                    <th className="pb-2 font-medium">Last sync</th>
                  </tr>
                </thead>
                <tbody>
                  {lookupResult.connections.map((c) => (
                    <tr key={c.id} className="border-t border-border-subtle">
                      <td className="py-2 capitalize text-primary">{c.provider}</td>
                      <td className="py-2 capitalize text-primary">{c.health.replace(/_/g, " ")}</td>
                      <td className="py-2 text-tertiary">
                        {c.lastSuccessfulSyncAt ? new Date(c.lastSuccessfulSyncAt).toLocaleString() : "never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Entitlements</p>
              {lookupResult.entitlements.length === 0 && <p className="text-tertiary">No entitlements — on the free plan by default.</p>}
              {lookupResult.entitlements.length > 0 && (
                <table className="mb-3 w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Plan</th>
                      <th className="pb-2 font-medium">Source</th>
                      <th className="pb-2 font-medium">Effective</th>
                      <th className="pb-2 font-medium">Reason</th>
                      <th className="pb-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {lookupResult.entitlements.map((e) => {
                      const active = !e.effectiveTo || new Date(e.effectiveTo) > new Date();
                      const manageable = ADMIN_MANAGEABLE_SOURCES.has(e.source);
                      return (
                        <tr key={e.id} className="border-t border-border-subtle">
                          <td className="py-2 capitalize text-primary">{e.planKey}</td>
                          <td className="py-2 capitalize text-tertiary">{e.source.replace(/_/g, " ")}</td>
                          <td className="py-2 text-tertiary">
                            {new Date(e.effectiveFrom).toLocaleDateString()} –{" "}
                            {e.effectiveTo ? new Date(e.effectiveTo).toLocaleDateString() : "ongoing"}
                          </td>
                          <td className="py-2 text-tertiary">{e.reason ?? "—"}</td>
                          <td className="py-2 text-right">
                            {active && manageable && (
                              <button
                                onClick={() => revokeEntitlement(e.id)}
                                disabled={revokingId === e.id}
                                className="text-critical-subtle-text hover:underline disabled:opacity-50"
                              >
                                {revokingId === e.id ? "Revoking…" : "Revoke"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              <div className="flex flex-wrap items-end gap-2 rounded-lg bg-subtle p-3">
                <div>
                  <label className="mb-1 block text-xs text-tertiary">Grant plan</label>
                  <select
                    value={grantPlanKey}
                    onChange={(e) => setGrantPlanKey(e.target.value as (typeof PLAN_KEYS)[number])}
                    className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                  >
                    {PLAN_KEYS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="min-w-[200px] flex-1">
                  <label className="mb-1 block text-xs text-tertiary">Reason (required)</label>
                  <input
                    value={grantReason}
                    onChange={(e) => setGrantReason(e.target.value)}
                    placeholder="e.g. comp for outage on 2026-08-20"
                    className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs text-tertiary">Days (blank = indefinite)</label>
                  <input
                    type="number"
                    min={1}
                    value={grantDurationDays}
                    onChange={(e) => setGrantDurationDays(e.target.value)}
                    className="h-9 w-24 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                  />
                </div>
                <button
                  onClick={grantEntitlement}
                  disabled={grantSubmitting || !grantReason.trim()}
                  className="h-9 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
                >
                  {grantSubmitting ? "Granting…" : "Grant"}
                </button>
              </div>
              {grantError && <p className="mt-2 text-sm text-critical-subtle-text">{grantError}</p>}
            </div>
          </div>
        )}
      </Section>

      <Section title="Connector health">
        {!health && <p className="text-sm text-tertiary">Loading…</p>}
        {health && (
          <div className="flex flex-wrap gap-3">
            <div className="rounded-lg bg-subtle px-4 py-2">
              <p className="text-xs text-tertiary">Total active</p>
              <p className="text-lg font-semibold text-primary">{health.total}</p>
            </div>
            {Object.entries(health.byHealth).map(([state, count]) => (
              <div key={state} className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs capitalize text-tertiary">{state.replace(/_/g, " ")}</p>
                <p className="text-lg font-semibold text-primary">{count}</p>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent audit events">
        {!auditEvents && <p className="text-sm text-tertiary">Loading…</p>}
        {auditEvents && auditEvents.length === 0 && <p className="text-sm text-tertiary">No audited actions yet.</p>}
        {auditEvents && auditEvents.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">When</th>
                <th className="pb-2 font-medium">Actor</th>
                <th className="pb-2 font-medium">Action</th>
                <th className="pb-2 font-medium">Resource</th>
                <th className="pb-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {auditEvents.map((e) => (
                <tr key={e.id} className="border-t border-border-subtle">
                  <td className="py-2 text-tertiary">{new Date(e.occurredAt).toLocaleString()}</td>
                  <td className="py-2 text-primary">
                    {e.actorType}
                    {e.actorId ? ` (${e.actorId.slice(0, 12)}…)` : ""}
                  </td>
                  <td className="py-2 text-primary">{e.action}</td>
                  <td className="py-2 text-tertiary">
                    {e.resourceType}:{e.resourceId.slice(0, 16)}
                  </td>
                  <td className="py-2">
                    <span
                      className={
                        e.result === "success"
                          ? "text-positive"
                          : e.result === "denied"
                            ? "text-warning"
                            : "text-critical"
                      }
                    >
                      {e.result}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
