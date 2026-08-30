"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, ApiError, swrFetcher } from "@/lib/api-client";

interface UserLookupResult {
  id: string;
  email: string | null;
  status: string;
  deletedAt: string | null;
  createdAt: string;
  connections: Array<{
    id: string;
    provider: string;
    health: string;
    healthDetail: string | null;
    lastSuccessfulSyncAt: string | null;
  }>;
  entitlements: Array<{ id: string; planKey: string; source: string; effectiveFrom: string; effectiveTo: string | null; reason: string | null }>;
  recentExtractionFailures: Array<{ id: string; extractorName: string; modelKey: string | null; errorDetail: string | null; startedAt: string }>;
  exportJobs: Array<{ id: string; state: string; errorMessage: string | null; requestedAt: string; completedAt: string | null; expiresAt: string | null }>;
}

const ADMIN_MANAGEABLE_SOURCES = new Set(["support_granted", "promotional", "grandfathered", "referral", "partner_sponsored"]);
const PLAN_KEYS = ["free", "plus", "family", "pro_agent"] as const;

interface ConnectorHealthSummary {
  total: number;
  byHealth: Record<string, number>;
}

interface ModelHealthSummary {
  windowDays: number;
  totalRuns: number;
  byExtractor: Array<{
    extractorName: string;
    total: number;
    success: number;
    failed: number;
    running: number;
    successRate: number | null;
    avgLatencyMs: number | null;
  }>;
  recentFailures: Array<{ extractorName: string; modelKey: string | null; errorDetail: string | null; startedAt: string }>;
}

interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  updatedAt: string;
}

interface StripeCharge {
  id: string;
  amountMinorUnits: number;
  currency: string;
  createdAt: string;
  description: string | null;
  refunded: boolean;
  amountRefundedMinorUnits: number;
  status: string;
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

function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(minorUnits / 100);
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
  const [confirmingRefundId, setConfirmingRefundId] = useState<string | null>(null);
  const [refundNote, setRefundNote] = useState("");
  const [refundingId, setRefundingId] = useState<string | null>(null);
  const [refundError, setRefundError] = useState<string | null>(null);

  const { data: charges, mutate: mutateCharges } = useSWR<StripeCharge[]>(
    lookupResult ? `/v1/admin/users/${lookupResult.id}/charges` : null,
    swrFetcher,
  );

  const { data: health } = useSWR<ConnectorHealthSummary>("/v1/admin/connectors/health", swrFetcher, {
    refreshInterval: 30_000,
  });
  const { data: modelHealth } = useSWR<ModelHealthSummary>("/v1/admin/model-health", swrFetcher, { refreshInterval: 30_000 });
  const { data: auditEvents } = useSWR<AuditEvent[]>("/v1/admin/audit-events", swrFetcher, { refreshInterval: 15_000 });
  const { data: flags, mutate: mutateFlags } = useSWR<FeatureFlag[]>("/v1/admin/feature-flags", swrFetcher);
  const [flagBusyKey, setFlagBusyKey] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);

  async function toggleFlag(flag: FeatureFlag) {
    setFlagBusyKey(flag.key);
    setFlagError(null);
    try {
      await api.post(`/v1/admin/feature-flags/${flag.key}`, { enabled: !flag.enabled, description: flag.description });
      await mutateFlags();
    } catch (err) {
      setFlagError(err instanceof ApiError ? err.message : "Couldn't update that flag.");
    } finally {
      setFlagBusyKey(null);
    }
  }

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

  async function refundCharge(chargeId: string) {
    setRefundingId(chargeId);
    setRefundError(null);
    try {
      await api.post(`/v1/admin/charges/${chargeId}/refund`, { note: refundNote.trim() || undefined });
      setConfirmingRefundId(null);
      setRefundNote("");
      await mutateCharges();
    } catch (err) {
      setRefundError(err instanceof ApiError ? err.message : "Couldn't issue that refund.");
    } finally {
      setRefundingId(null);
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
                <p className={`font-medium ${lookupResult.status === "active" ? "text-primary" : "text-critical-subtle-text"}`}>
                  {lookupResult.status.replace(/_/g, " ")}
                  {lookupResult.deletedAt && ` (${new Date(lookupResult.deletedAt).toLocaleDateString()})`}
                </p>
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
                    <th className="pb-2 font-medium">Detail</th>
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
                      <td className="py-2 text-tertiary">{c.healthDetail ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Recent extraction failures</p>
              {lookupResult.recentExtractionFailures.length === 0 && (
                <p className="text-tertiary">No recent extraction failures for this user.</p>
              )}
              {lookupResult.recentExtractionFailures.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Extractor</th>
                      <th className="pb-2 font-medium">Model</th>
                      <th className="pb-2 font-medium">Error</th>
                      <th className="pb-2 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lookupResult.recentExtractionFailures.map((f) => (
                      <tr key={f.id} className="border-t border-border-subtle">
                        <td className="py-2 text-primary">{f.extractorName}</td>
                        <td className="py-2 text-tertiary">{f.modelKey ?? "—"}</td>
                        <td className="py-2 text-critical-subtle-text">{f.errorDetail ?? "—"}</td>
                        <td className="py-2 text-tertiary">{new Date(f.startedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Privacy requests (data export)</p>
              {lookupResult.exportJobs.length === 0 && <p className="text-tertiary">No export requests on file.</p>}
              {lookupResult.exportJobs.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">State</th>
                      <th className="pb-2 font-medium">Requested</th>
                      <th className="pb-2 font-medium">Completed</th>
                      <th className="pb-2 font-medium">Expires</th>
                      <th className="pb-2 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lookupResult.exportJobs.map((j) => (
                      <tr key={j.id} className="border-t border-border-subtle">
                        <td className="py-2 capitalize text-primary">{j.state}</td>
                        <td className="py-2 text-tertiary">{new Date(j.requestedAt).toLocaleString()}</td>
                        <td className="py-2 text-tertiary">{j.completedAt ? new Date(j.completedAt).toLocaleString() : "—"}</td>
                        <td className="py-2 text-tertiary">{j.expiresAt ? new Date(j.expiresAt).toLocaleString() : "—"}</td>
                        <td className="py-2 text-critical-subtle-text">{j.errorMessage ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

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

            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Billing (live Stripe data)</p>
              {!charges && <p className="text-tertiary">Loading…</p>}
              {charges && charges.length === 0 && <p className="text-tertiary">No Stripe charges on file for this account.</p>}
              {charges && charges.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Date</th>
                      <th className="pb-2 font-medium">Amount</th>
                      <th className="pb-2 font-medium">Description</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {charges.map((c) => (
                      <tr key={c.id} className="border-t border-border-subtle align-top">
                        <td className="py-2 text-tertiary">{new Date(c.createdAt).toLocaleDateString()}</td>
                        <td className="py-2 text-primary">{formatMoney(c.amountMinorUnits, c.currency)}</td>
                        <td className="py-2 text-tertiary">{c.description ?? "—"}</td>
                        <td className="py-2 text-tertiary">
                          {c.refunded
                            ? "Fully refunded"
                            : c.amountRefundedMinorUnits > 0
                              ? `Partially refunded (${formatMoney(c.amountRefundedMinorUnits, c.currency)})`
                              : c.status}
                        </td>
                        <td className="py-2 text-right">
                          {!c.refunded && confirmingRefundId !== c.id && (
                            <button
                              onClick={() => {
                                setConfirmingRefundId(c.id);
                                setRefundNote("");
                                setRefundError(null);
                              }}
                              className="text-critical-subtle-text hover:underline"
                            >
                              Refund
                            </button>
                          )}
                          {confirmingRefundId === c.id && (
                            <div className="flex flex-col items-end gap-1.5">
                              <input
                                value={refundNote}
                                onChange={(e) => setRefundNote(e.target.value)}
                                placeholder="Note for the audit log (optional)"
                                className="h-8 w-56 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
                              />
                              <div className="flex gap-2">
                                <button
                                  onClick={() => setConfirmingRefundId(null)}
                                  disabled={refundingId === c.id}
                                  className="text-xs text-tertiary hover:underline disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => refundCharge(c.id)}
                                  disabled={refundingId === c.id}
                                  className="rounded-lg bg-critical px-3 py-1 text-xs font-medium text-white hover:brightness-95 disabled:opacity-50"
                                >
                                  {refundingId === c.id ? "Refunding…" : `Confirm refund of ${formatMoney(c.amountMinorUnits, c.currency)}`}
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {refundError && <p className="mt-2 text-sm text-critical-subtle-text">{refundError}</p>}
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

      <Section title={`Model health (last ${modelHealth?.windowDays ?? 7} days)`}>
        {!modelHealth && <p className="text-sm text-tertiary">Loading…</p>}
        {modelHealth && modelHealth.totalRuns === 0 && (
          <p className="text-sm text-tertiary">No extraction runs recorded yet — nothing has gone through the AI pipeline in this window.</p>
        )}
        {modelHealth && modelHealth.totalRuns > 0 && (
          <div className="space-y-4">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase text-tertiary">
                  <th className="pb-2 font-medium">Extractor</th>
                  <th className="pb-2 font-medium">Runs</th>
                  <th className="pb-2 font-medium">Success rate</th>
                  <th className="pb-2 font-medium">Avg latency</th>
                </tr>
              </thead>
              <tbody>
                {modelHealth.byExtractor.map((e) => (
                  <tr key={e.extractorName} className="border-t border-border-subtle">
                    <td className="py-2 text-primary">{e.extractorName}</td>
                    <td className="py-2 text-tertiary">
                      {e.total} ({e.success} ok, {e.failed} failed{e.running > 0 ? `, ${e.running} running` : ""})
                    </td>
                    <td className="py-2">
                      <span className={e.successRate !== null && e.successRate < 0.9 ? "text-warning" : "text-positive"}>
                        {e.successRate !== null ? `${Math.round(e.successRate * 100)}%` : "—"}
                      </span>
                    </td>
                    <td className="py-2 text-tertiary">{e.avgLatencyMs !== null ? `${e.avgLatencyMs.toLocaleString()}ms` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {modelHealth.recentFailures.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Recent failures</p>
                <ul className="space-y-1.5 text-sm">
                  {modelHealth.recentFailures.map((f, i) => (
                    <li key={i} className="text-tertiary">
                      <span className="text-primary">{f.extractorName}</span> — {f.errorDetail ?? "unknown error"}{" "}
                      <span className="text-xs">({new Date(f.startedAt).toLocaleString()})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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

      <Section title="Feature flags">
        <p className="mb-3 text-sm text-tertiary">
          Remote kill switches — flip one off instantly for every user, no app release needed. A key with no row here is off by default.
        </p>
        {!flags && <p className="text-sm text-tertiary">Loading…</p>}
        {flags && flags.length === 0 && <p className="text-sm text-tertiary">No flags configured yet.</p>}
        {flags && flags.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">Key</th>
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 font-medium">Updated</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.key} className="border-t border-border-subtle">
                  <td className="py-2 font-mono text-xs text-primary">{f.key}</td>
                  <td className="py-2 text-tertiary">{f.description}</td>
                  <td className="py-2 text-tertiary">{new Date(f.updatedAt).toLocaleString()}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => toggleFlag(f)}
                      disabled={flagBusyKey === f.key}
                      className={`rounded-lg px-3 py-1 text-xs font-medium disabled:opacity-50 ${
                        f.enabled ? "bg-critical-subtle text-critical-subtle-text" : "bg-positive-subtle text-positive-subtle-text"
                      }`}
                    >
                      {flagBusyKey === f.key ? "Working…" : f.enabled ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {flagError && <p className="mt-2 text-sm text-critical-subtle-text">{flagError}</p>}
      </Section>
    </div>
  );
}
