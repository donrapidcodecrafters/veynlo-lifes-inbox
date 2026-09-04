"use client";

import { useState } from "react";
import useSWR from "swr";
import { api, apiErrorMessage, swrFetcher } from "@/lib/api-client";

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
  automationRules: Array<{ id: string; name: string; riskTier: string; approvalMode: string; enabled: boolean; createdAt: string }>;
  recentAutomationRuns: Array<{ id: string; ruleId: string; state: string; createdAt: string }>;
}

const ADMIN_MANAGEABLE_SOURCES = new Set(["support_granted", "promotional", "grandfathered", "referral", "partner_sponsored"]);
const PLAN_KEYS = ["free", "plus", "family", "pro_agent"] as const;

interface ConnectorHealthSummary {
  total: number;
  byHealth: Record<string, number>;
}

type QueueHealthSummary = Record<string, { waiting: number; active: number; delayed: number; completed: number; failed: number }>;

interface PrivacyRequestsWorklist {
  pendingExports: Array<{ id: string; userId: string; email: string | null; state: string; requestedAt: string }>;
  pendingDeletions: Array<{ id: string; email: string | null; deletedAt: string | null; updatedAt: string }>;
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
  // §47.4/§39.2 — the optional numeric/string payload a few flags carry alongside their bool (e.g. the
  // backfill cost-pressure pause's per-user monthly cap in cost minor units). Null for every ordinary
  // boolean-only flag.
  value: string | null;
  updatedAt: string;
}

interface AiCostSummary {
  windowDays: number;
  totalCostMinorUnits: number;
  totalRuns: number;
  byDay: Array<{ day: string; costMinorUnits: number }>;
  byUser: Array<{ userId: string; email: string | null; costMinorUnits: number; runs: number }>;
}

/** §48 "Product Analytics, Experimentation & Growth" — AdminService.analyticsSummary's response shape. */
interface AnalyticsSummary {
  windowDays: number;
  totalEvents: number;
  distinctUsers: number;
  byDay: Array<{ day: string; count: number }>;
  byEvent: Array<{ eventName: string; count: number }>;
}

interface ModelEvalRun {
  id: string;
  modelKey: string;
  goldenSetVersion: string;
  totalCases: number;
  passedCases: number;
  passRate: number;
  bySchema: Array<{ schemaName: string; total: number; passed: number; passRate: number }>;
  triggeredBy: string | null;
  runAt: string;
}

interface ModelEvalSummary {
  latestRun: ModelEvalRun | null;
  history: ModelEvalRun[];
}

/** costMinorUnits is real USD cents (see AnthropicExtractionService.computeCostMinorUnits) — same
 * convention as every other money figure in this codebase. */
function formatUsdFromMinorUnits(minorUnits: number): string {
  return `$${(minorUnits / 100).toFixed(2)}`;
}

interface PromptSecuritySummary {
  windowDays: number;
  totalDetections: number;
  recent: Array<{ id: string; sourceEventId: string | null; kind: string; detail: string | null; createdAt: string }>;
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
    <section className="overflow-x-auto rounded-xl border border-border-subtle bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Admin's own equivalent of apps/web/src/components/ui/fetch-error.tsx and apps/mobile's
 * src/components/fetch-error.tsx — this app has no shared UI kit (every dashboard section is inline in
 * this one file), so a small local component keeps the same "third branch" pattern rather than every
 * section's `!x && <p>Loading…</p>` staying stuck on that text forever when `x` is undefined because the
 * fetch actually failed (a 500/network error), not because it's still in flight.
 */
function SectionFetchError({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="flex items-center gap-3 rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
      Couldn&apos;t load this section.
      <button onClick={onRetry} className="font-medium underline underline-offset-2">
        Retry
      </button>
    </p>
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
  const [suspendReason, setSuspendReason] = useState("");
  const [suspendSubmitting, setSuspendSubmitting] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);
  const [forceLogoutSubmitting, setForceLogoutSubmitting] = useState(false);
  const [forceLogoutMessage, setForceLogoutMessage] = useState<string | null>(null);

  const { data: health, error: healthError, mutate: mutateHealth } = useSWR<ConnectorHealthSummary>("/v1/admin/connectors/health", swrFetcher, {
    refreshInterval: 30_000,
  });
  const { data: modelHealth, error: modelHealthError, mutate: mutateModelHealth } = useSWR<ModelHealthSummary>("/v1/admin/model-health", swrFetcher, { refreshInterval: 30_000 });
  const { data: aiCost, error: aiCostError, mutate: mutateAiCost } = useSWR<AiCostSummary>("/v1/admin/ai-cost", swrFetcher, { refreshInterval: 30_000 });
  const { data: analytics, error: analyticsError, mutate: mutateAnalytics } = useSWR<AnalyticsSummary>("/v1/admin/analytics", swrFetcher, { refreshInterval: 30_000 });
  const { data: modelEval, error: modelEvalError, mutate: mutateModelEval } = useSWR<ModelEvalSummary>("/v1/admin/model-eval-runs", swrFetcher, { refreshInterval: 60_000 });
  const { data: queueHealth, error: queueHealthError, mutate: mutateQueueHealth } = useSWR<QueueHealthSummary>("/v1/admin/queues/health", swrFetcher, { refreshInterval: 15_000 });
  const { data: privacyRequests, error: privacyRequestsError, mutate: mutatePrivacyRequests } = useSWR<PrivacyRequestsWorklist>("/v1/admin/privacy-requests", swrFetcher, { refreshInterval: 30_000 });
  const { data: auditEvents, error: auditEventsError, mutate: mutateAuditEvents } = useSWR<AuditEvent[]>("/v1/admin/audit-events", swrFetcher, { refreshInterval: 15_000 });
  const { data: flags, error: flagsError, mutate: mutateFlags } = useSWR<FeatureFlag[]>("/v1/admin/feature-flags", swrFetcher);
  const [flagBusyKey, setFlagBusyKey] = useState<string | null>(null);
  const [flagError, setFlagError] = useState<string | null>(null);
  const { data: promptSecurity, error: promptSecurityError, mutate: mutatePromptSecurity } = useSWR<PromptSecuritySummary>("/v1/admin/prompt-security", swrFetcher, {
    refreshInterval: 30_000,
  });
  const [newFlagKey, setNewFlagKey] = useState("");
  const [newFlagDescription, setNewFlagDescription] = useState("");
  const [newFlagValue, setNewFlagValue] = useState("");
  const [newFlagSubmitting, setNewFlagSubmitting] = useState(false);
  const [newFlagError, setNewFlagError] = useState<string | null>(null);
  // §47.4/§39.2 — per-row draft for editing a flag's numeric `value` (e.g. the backfill cost-pressure
  // pause's per-user monthly cap) independently of toggling `enabled`.
  const [flagValueDrafts, setFlagValueDrafts] = useState<Record<string, string>>({});
  const [flagValueBusyKey, setFlagValueBusyKey] = useState<string | null>(null);

  // §AI-003 kill switch — creates the `ai_extraction_paused`-style row a brand-new flag key needs before
  // it can show up in the table below to be toggled (a key with no row is off by default and simply
  // invisible here, same as `FeatureFlagsService.isEnabled`'s own doc comment). Works for any flag key, not
  // just this one — the same generic remote-kill-switch mechanism the Android notification-listener flag
  // already uses.
  async function createFlag() {
    const key = newFlagKey.trim();
    if (!key) return;
    setNewFlagSubmitting(true);
    setNewFlagError(null);
    try {
      await api.post(`/v1/admin/feature-flags/${encodeURIComponent(key)}`, {
        enabled: false,
        description: newFlagDescription.trim() || key,
        ...(newFlagValue.trim() ? { value: newFlagValue.trim() } : {}),
      });
      setNewFlagKey("");
      setNewFlagDescription("");
      setNewFlagValue("");
      await mutateFlags();
    } catch (err) {
      setNewFlagError(apiErrorMessage(err, "Couldn't create that flag."));
    } finally {
      setNewFlagSubmitting(false);
    }
  }

  async function toggleFlag(flag: FeatureFlag) {
    setFlagBusyKey(flag.key);
    setFlagError(null);
    try {
      await api.post(`/v1/admin/feature-flags/${flag.key}`, {
        enabled: !flag.enabled,
        description: flag.description,
        ...(flag.value !== null ? { value: flag.value } : {}),
      });
      await mutateFlags();
    } catch (err) {
      setFlagError(apiErrorMessage(err, "Couldn't update that flag."));
    } finally {
      setFlagBusyKey(null);
    }
  }

  /** §47.4/§39.2 — saves just the numeric `value` (e.g. a cost threshold), leaving `enabled`/`description`
   * untouched. */
  async function saveFlagValue(flag: FeatureFlag) {
    const draft = flagValueDrafts[flag.key];
    if (draft === undefined) return;
    setFlagValueBusyKey(flag.key);
    setFlagError(null);
    try {
      await api.post(`/v1/admin/feature-flags/${flag.key}`, { enabled: flag.enabled, description: flag.description, value: draft.trim() });
      await mutateFlags();
    } catch (err) {
      setFlagError(apiErrorMessage(err, "Couldn't update that flag's value."));
    } finally {
      setFlagValueBusyKey(null);
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
      setLookupError(apiErrorMessage(err, "Lookup failed."));
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
      setGrantError(apiErrorMessage(err, "Couldn't grant that entitlement."));
    } finally {
      setGrantSubmitting(false);
    }
  }

  async function suspendOrUnsuspend() {
    if (!lookupResult) return;
    const suspending = lookupResult.status !== "suspended";
    if (suspending && !suspendReason.trim()) return;
    setSuspendSubmitting(true);
    setSuspendError(null);
    try {
      if (suspending) {
        await api.post(`/v1/admin/users/${lookupResult.id}/suspend`, { reason: suspendReason });
      } else {
        await api.post(`/v1/admin/users/${lookupResult.id}/unsuspend`);
      }
      setSuspendReason("");
      await reRunLookup();
    } catch (err) {
      setSuspendError(apiErrorMessage(err, suspending ? "Couldn't suspend that account." : "Couldn't unsuspend that account."));
    } finally {
      setSuspendSubmitting(false);
    }
  }

  async function forceLogout() {
    if (!lookupResult) return;
    setForceLogoutSubmitting(true);
    setForceLogoutMessage(null);
    try {
      await api.post(`/v1/admin/users/${lookupResult.id}/force-logout`);
      setForceLogoutMessage("Every session for this account has been signed out.");
    } catch (err) {
      setForceLogoutMessage(apiErrorMessage(err, "Couldn't force logout for that account."));
    } finally {
      setForceLogoutSubmitting(false);
    }
  }

  async function revokeEntitlement(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/admin/entitlements/${id}/revoke`);
      await reRunLookup();
    } catch (err) {
      setGrantError(apiErrorMessage(err, "Couldn't revoke that entitlement."));
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
                <p className="font-medium text-primary">
                  {lookupResult.entitlements.find((e) => !e.effectiveTo || new Date(e.effectiveTo) > new Date())?.planKey ?? "free"}
                </p>
              </div>
              <div>
                <p className="text-xs text-tertiary">Connections</p>
                <p className="font-medium text-primary">{lookupResult.connections.length}</p>
              </div>
            </div>

            {/* Account actions — suspend/unsuspend (docs/INCIDENT_RESPONSE.md's "users.status has a
                suspended value nothing ever sets" gap) and force-logout (its "no admin endpoint to
                force-revoke a consumer user's sessions" gap). Suspend is hidden once an account is already
                deletion_pending/deleted — AdminService.suspendUser itself also rejects that case, this just
                keeps the control from being offered for an action guaranteed to fail. */}
            {lookupResult.status !== "deletion_pending" && lookupResult.status !== "deleted" && (
              <div className="flex flex-wrap items-end gap-2 rounded-lg bg-subtle p-3">
                {lookupResult.status !== "suspended" ? (
                  <>
                    <div className="min-w-[220px] flex-1">
                      <label className="mb-1 block text-xs text-tertiary">Suspend reason (required)</label>
                      <input
                        value={suspendReason}
                        onChange={(e) => setSuspendReason(e.target.value)}
                        placeholder="e.g. reported fraud, ToS violation"
                        className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                      />
                    </div>
                    <button
                      onClick={suspendOrUnsuspend}
                      disabled={suspendSubmitting || !suspendReason.trim()}
                      className="h-9 rounded-lg bg-critical-subtle px-4 text-sm font-medium text-critical-subtle-text disabled:opacity-50"
                    >
                      {suspendSubmitting ? "Suspending…" : "Suspend account"}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={suspendOrUnsuspend}
                    disabled={suspendSubmitting}
                    className="h-9 rounded-lg bg-positive-subtle px-4 text-sm font-medium text-positive-subtle-text disabled:opacity-50"
                  >
                    {suspendSubmitting ? "Reactivating…" : "Unsuspend account"}
                  </button>
                )}
                <button
                  onClick={forceLogout}
                  disabled={forceLogoutSubmitting}
                  className="h-9 rounded-lg border border-border-default bg-surface px-4 text-sm font-medium text-primary hover:bg-subtle disabled:opacity-50"
                >
                  {forceLogoutSubmitting ? "Signing out…" : "Force logout (all devices)"}
                </button>
              </div>
            )}
            {suspendError && <p className="text-sm text-critical-subtle-text">{suspendError}</p>}
            {forceLogoutMessage && <p className="text-sm text-tertiary">{forceLogoutMessage}</p>}

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
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Automation rules</p>
              {lookupResult.automationRules.length === 0 && <p className="text-tertiary">No automation rules.</p>}
              {lookupResult.automationRules.length > 0 && (
                <table className="mb-3 w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Name</th>
                      <th className="pb-2 font-medium">Risk</th>
                      <th className="pb-2 font-medium">Approval</th>
                      <th className="pb-2 font-medium">Enabled</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lookupResult.automationRules.map((r) => (
                      <tr key={r.id} className="border-t border-border-subtle">
                        <td className="py-2 text-primary">{r.name}</td>
                        <td className="py-2 text-tertiary">{r.riskTier}</td>
                        <td className="py-2 text-tertiary">{r.approvalMode}</td>
                        <td className="py-2 text-tertiary">{r.enabled ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {lookupResult.recentAutomationRuns.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Run state</th>
                      <th className="pb-2 font-medium">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lookupResult.recentAutomationRuns.map((run) => (
                      <tr key={run.id} className="border-t border-border-subtle">
                        <td className="py-2 capitalize text-primary">{run.state.replace(/_/g, " ")}</td>
                        <td className="py-2 text-tertiary">{new Date(run.createdAt).toLocaleString()}</td>
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
          </div>
        )}
      </Section>

      <Section title="Connector health">
        {!health && healthError && <SectionFetchError onRetry={() => mutateHealth()} />}
        {!health && !healthError && <p className="text-sm text-tertiary">Loading…</p>}
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

      <Section title="Job queue health">
        {!queueHealth && queueHealthError && <SectionFetchError onRetry={() => mutateQueueHealth()} />}
        {!queueHealth && !queueHealthError && <p className="text-sm text-tertiary">Loading…</p>}
        {queueHealth && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">Queue</th>
                <th className="pb-2 font-medium">Waiting</th>
                <th className="pb-2 font-medium">Active</th>
                <th className="pb-2 font-medium">Delayed</th>
                <th className="pb-2 font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(queueHealth).map(([name, counts]) => (
                <tr key={name} className="border-t border-border-subtle">
                  <td className="py-2 font-mono text-xs text-primary">{name}</td>
                  <td className="py-2 text-tertiary">{counts.waiting}</td>
                  <td className="py-2 text-tertiary">{counts.active}</td>
                  <td className="py-2 text-tertiary">{counts.delayed}</td>
                  <td className={`py-2 ${counts.failed > 0 ? "text-critical-subtle-text" : "text-tertiary"}`}>{counts.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={`Model health (last ${modelHealth?.windowDays ?? 7} days)`}>
        {!modelHealth && modelHealthError && <SectionFetchError onRetry={() => mutateModelHealth()} />}
        {!modelHealth && !modelHealthError && <p className="text-sm text-tertiary">Loading…</p>}
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

      <Section title={`AI cost (last ${aiCost?.windowDays ?? 30} days)`}>
        <p className="mb-3 text-sm text-tertiary">
          §47.4 unit-cost controls — real spend computed from each extraction run&apos;s actual token counts
          (Anthropic&apos;s published per-model pricing), not an estimate.
        </p>
        {!aiCost && aiCostError && <SectionFetchError onRetry={() => mutateAiCost()} />}
        {!aiCost && !aiCostError && <p className="text-sm text-tertiary">Loading…</p>}
        {aiCost && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Total spend</p>
                <p className="text-lg font-semibold text-primary">{formatUsdFromMinorUnits(aiCost.totalCostMinorUnits)}</p>
              </div>
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Extraction runs</p>
                <p className="text-lg font-semibold text-primary">{aiCost.totalRuns.toLocaleString()}</p>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Cost by day</p>
              {aiCost.byDay.length === 0 && <p className="text-sm text-tertiary">No priced extraction runs in this window.</p>}
              {aiCost.byDay.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Day</th>
                      <th className="pb-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiCost.byDay.map((d) => (
                      <tr key={d.day} className="border-t border-border-subtle">
                        <td className="py-2 text-tertiary">{new Date(d.day).toLocaleDateString()}</td>
                        <td className="py-2 text-primary">{formatUsdFromMinorUnits(d.costMinorUnits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Highest-spending users</p>
              {aiCost.byUser.length === 0 && <p className="text-sm text-tertiary">No priced extraction runs in this window.</p>}
              {aiCost.byUser.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium">Runs</th>
                      <th className="pb-2 font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiCost.byUser.map((u) => (
                      <tr key={u.userId} className="border-t border-border-subtle">
                        <td className="py-2 text-primary">{u.email ?? u.userId}</td>
                        <td className="py-2 text-tertiary">{u.runs.toLocaleString()}</td>
                        <td className="py-2 text-tertiary">{formatUsdFromMinorUnits(u.costMinorUnits)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section title="Extraction quality evals">
        <p className="mb-3 text-sm text-tertiary">
          §39.2 offline evaluation suite — the golden-set eval harness (<code>pnpm run eval:extraction</code>, opt-in and
          manually/scheduler-run, never on every commit since it spends real API budget) scores real extraction output
          against hand-authored expected fields, per schema. A dropping pass rate after a prompt or model change is a real
          regression, not a rendering artifact.
        </p>
        {!modelEval && modelEvalError && <SectionFetchError onRetry={() => mutateModelEval()} />}
        {!modelEval && !modelEvalError && <p className="text-sm text-tertiary">Loading…</p>}
        {modelEval && !modelEval.latestRun && (
          <p className="text-sm text-tertiary">The golden-set eval harness has never been run yet — see this section&apos;s note above for how.</p>
        )}
        {modelEval && modelEval.latestRun && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Latest pass rate</p>
                <p className={`text-lg font-semibold ${modelEval.latestRun.passRate < 1 ? "text-warning" : "text-positive"}`}>
                  {Math.round(modelEval.latestRun.passRate * 100)}% ({modelEval.latestRun.passedCases}/{modelEval.latestRun.totalCases})
                </p>
              </div>
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Model / golden set</p>
                <p className="text-sm font-medium text-primary">
                  {modelEval.latestRun.modelKey} · {modelEval.latestRun.goldenSetVersion}
                </p>
              </div>
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Run at</p>
                <p className="text-sm font-medium text-primary">{new Date(modelEval.latestRun.runAt).toLocaleString()}</p>
                <p className="text-xs text-tertiary">by {modelEval.latestRun.triggeredBy ?? "unknown"}</p>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Latest run — per schema</p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-tertiary">
                    <th className="pb-2 font-medium">Schema</th>
                    <th className="pb-2 font-medium">Cases</th>
                    <th className="pb-2 font-medium">Pass rate</th>
                  </tr>
                </thead>
                <tbody>
                  {modelEval.latestRun.bySchema.map((s) => (
                    <tr key={s.schemaName} className="border-t border-border-subtle">
                      <td className="py-2 text-primary">{s.schemaName.replace(/_/g, " ")}</td>
                      <td className="py-2 text-tertiary">
                        {s.passed}/{s.total}
                      </td>
                      <td className="py-2">
                        <span className={s.passRate < 1 ? "text-warning" : "text-positive"}>{Math.round(s.passRate * 100)}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {modelEval.history.length > 1 && (
              <div className="border-t border-border-subtle pt-3">
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Run history</p>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">Run at</th>
                      <th className="pb-2 font-medium">Model</th>
                      <th className="pb-2 font-medium">Pass rate</th>
                      <th className="pb-2 font-medium">Triggered by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelEval.history.map((r) => (
                      <tr key={r.id} className="border-t border-border-subtle">
                        <td className="py-2 text-tertiary">{new Date(r.runAt).toLocaleString()}</td>
                        <td className="py-2 text-tertiary">{r.modelKey}</td>
                        <td className="py-2">
                          <span className={r.passRate < 1 ? "text-warning" : "text-positive"}>
                            {Math.round(r.passRate * 100)}% ({r.passedCases}/{r.totalCases})
                          </span>
                        </td>
                        <td className="py-2 text-tertiary">{r.triggeredBy ?? "unknown"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={`Product analytics (last ${analytics?.windowDays ?? 30} days)`}>
        <p className="mb-3 text-sm text-tertiary">
          §48 first-party product-analytics event log (`product_events`) — behavior only, never raw message/
          document content (see AnalyticsService.track&apos;s sanitizer). Aggregated across all users; never
          exposed to anyone but an admin operator.
        </p>
        {!analytics && analyticsError && <SectionFetchError onRetry={() => mutateAnalytics()} />}
        {!analytics && !analyticsError && <p className="text-sm text-tertiary">Loading…</p>}
        {analytics && analytics.totalEvents === 0 && (
          <p className="text-sm text-tertiary">No product events recorded yet in this window.</p>
        )}
        {analytics && analytics.totalEvents > 0 && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Total events</p>
                <p className="text-lg font-semibold text-primary">{analytics.totalEvents.toLocaleString()}</p>
              </div>
              <div className="rounded-lg bg-subtle px-4 py-2">
                <p className="text-xs text-tertiary">Distinct users</p>
                <p className="text-lg font-semibold text-primary">{analytics.distinctUsers.toLocaleString()}</p>
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Events by day</p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-tertiary">
                    <th className="pb-2 font-medium">Day</th>
                    <th className="pb-2 font-medium">Events</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.byDay.map((d) => (
                    <tr key={d.day} className="border-t border-border-subtle">
                      <td className="py-2 text-tertiary">{new Date(d.day).toLocaleDateString()}</td>
                      <td className="py-2 text-primary">{d.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Events by name</p>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-tertiary">
                    <th className="pb-2 font-medium">Event</th>
                    <th className="pb-2 font-medium">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.byEvent.map((e) => (
                    <tr key={e.eventName} className="border-t border-border-subtle">
                      <td className="py-2 font-mono text-xs text-primary">{e.eventName}</td>
                      <td className="py-2 text-tertiary">{e.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Section>

      <Section title="Prompt-injection detections">
        <p className="mb-3 text-sm text-tertiary">
          §AI-003 — a coarse, post-hoc heuristic scan of the untrusted content fed into every AI extraction call. The
          schema-constrained tool use + validation is the actual defense; this only measures how often an attempt is even
          tried.
        </p>
        {!promptSecurity && promptSecurityError && <SectionFetchError onRetry={() => mutatePromptSecurity()} />}
        {!promptSecurity && !promptSecurityError && <p className="text-sm text-tertiary">Loading…</p>}
        {promptSecurity && (
          <div className="space-y-3">
            <div className="rounded-lg bg-subtle px-4 py-2 inline-block">
              <p className="text-xs text-tertiary">Detected in the last {promptSecurity.windowDays} days</p>
              <p className="text-lg font-semibold text-primary">
                {promptSecurity.totalDetections} potential prompt-injection attempt{promptSecurity.totalDetections === 1 ? "" : "s"} detected
              </p>
            </div>
            {promptSecurity.recent.length > 0 && (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase text-tertiary">
                    <th className="pb-2 font-medium">When</th>
                    <th className="pb-2 font-medium">Kind</th>
                    <th className="pb-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {promptSecurity.recent.map((r) => (
                    <tr key={r.id} className="border-t border-border-subtle">
                      <td className="py-2 text-tertiary">{new Date(r.createdAt).toLocaleString()}</td>
                      <td className="py-2 text-primary">{r.kind.replace(/_/g, " ")}</td>
                      <td className="py-2 text-tertiary">{r.detail ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </Section>

      <Section title="Privacy requests (all users)">
        {!privacyRequests && privacyRequestsError && <SectionFetchError onRetry={() => mutatePrivacyRequests()} />}
        {!privacyRequests && !privacyRequestsError && <p className="text-sm text-tertiary">Loading…</p>}
        {privacyRequests && (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">
                Pending exports ({privacyRequests.pendingExports.length})
              </p>
              {privacyRequests.pendingExports.length === 0 && <p className="text-sm text-tertiary">None queued or processing.</p>}
              {privacyRequests.pendingExports.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium">State</th>
                      <th className="pb-2 font-medium">Requested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {privacyRequests.pendingExports.map((j) => (
                      <tr key={j.id} className="border-t border-border-subtle">
                        <td className="py-2 text-primary">{j.email ?? j.userId}</td>
                        <td className="py-2 capitalize text-tertiary">{j.state}</td>
                        <td className="py-2 text-tertiary">{new Date(j.requestedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="border-t border-border-subtle pt-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">
                Pending deletions ({privacyRequests.pendingDeletions.length})
              </p>
              {privacyRequests.pendingDeletions.length === 0 && <p className="text-sm text-tertiary">None in progress.</p>}
              {privacyRequests.pendingDeletions.length > 0 && (
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase text-tertiary">
                      <th className="pb-2 font-medium">User</th>
                      <th className="pb-2 font-medium">Requested</th>
                    </tr>
                  </thead>
                  <tbody>
                    {privacyRequests.pendingDeletions.map((u) => (
                      <tr key={u.id} className="border-t border-border-subtle">
                        <td className="py-2 text-primary">{u.email ?? u.id}</td>
                        <td className="py-2 text-tertiary">{new Date(u.updatedAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section title="Recent audit events">
        {!auditEvents && auditEventsError && <SectionFetchError onRetry={() => mutateAuditEvents()} />}
        {!auditEvents && !auditEventsError && <p className="text-sm text-tertiary">Loading…</p>}
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
        {!flags && flagsError && <SectionFetchError onRetry={() => mutateFlags()} />}
        {!flags && !flagsError && <p className="text-sm text-tertiary">Loading…</p>}
        {flags && flags.length === 0 && <p className="text-sm text-tertiary">No flags configured yet.</p>}
        {flags && flags.length > 0 && (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-tertiary">
                <th className="pb-2 font-medium">Key</th>
                <th className="pb-2 font-medium">Description</th>
                <th className="pb-2 font-medium">Value</th>
                <th className="pb-2 font-medium">Updated</th>
                <th className="pb-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.key} className="border-t border-border-subtle">
                  <td className="py-2 font-mono text-xs text-primary">{f.key}</td>
                  <td className="py-2 text-tertiary">{f.description}</td>
                  <td className="py-2">
                    <div className="flex items-center gap-1.5">
                      <input
                        value={flagValueDrafts[f.key] ?? f.value ?? ""}
                        onChange={(e) => setFlagValueDrafts((prev) => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder="—"
                        className="h-8 w-24 rounded-lg border border-border-default bg-surface px-2 text-xs text-primary"
                      />
                      {flagValueDrafts[f.key] !== undefined && flagValueDrafts[f.key] !== (f.value ?? "") && (
                        <button
                          onClick={() => saveFlagValue(f)}
                          disabled={flagValueBusyKey === f.key}
                          className="rounded-lg bg-brand px-2 py-1 text-xs font-medium text-on-brand disabled:opacity-50"
                        >
                          {flagValueBusyKey === f.key ? "…" : "Save"}
                        </button>
                      )}
                    </div>
                  </td>
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

        <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border-subtle pt-4">
          <div className="min-w-[180px]">
            <label className="mb-1 block text-xs text-tertiary">New flag key</label>
            <input
              value={newFlagKey}
              onChange={(e) => setNewFlagKey(e.target.value)}
              placeholder="e.g. ai_extraction_paused"
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 font-mono text-sm text-primary"
            />
          </div>
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-xs text-tertiary">Description</label>
            <input
              value={newFlagDescription}
              onChange={(e) => setNewFlagDescription(e.target.value)}
              placeholder="What does flipping this off do?"
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            />
          </div>
          <div className="min-w-[120px]">
            <label className="mb-1 block text-xs text-tertiary">Value (optional)</label>
            <input
              value={newFlagValue}
              onChange={(e) => setNewFlagValue(e.target.value)}
              placeholder="e.g. 5000"
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            />
          </div>
          <button
            onClick={createFlag}
            disabled={newFlagSubmitting || !newFlagKey.trim()}
            className="h-9 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            {newFlagSubmitting ? "Creating…" : "Create (starts disabled)"}
          </button>
        </div>
        {newFlagError && <p className="mt-2 text-sm text-critical-subtle-text">{newFlagError}</p>}
      </Section>
    </div>
  );
}
