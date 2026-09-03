"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface TriggerDescriptor {
  kind: string;
  merchantContains: string | null;
  minAmountMinorUnits: number | null;
  maxAmountMinorUnits: number | null;
}
interface ActionDescriptor {
  kind: string;
  message: string | null;
  taskTitle: string | null;
  eventTitle: string | null;
  daysFromNow: number | null;
  prepareCancellationTitle: string | null;
}
interface AutomationRule {
  id: string;
  name: string;
  naturalLanguageSource: string | null;
  riskTier: string;
  approvalMode: "confirm_each_time" | "auto_low_risk";
  enabled: boolean;
  trigger: TriggerDescriptor | null;
  action: ActionDescriptor | null;
}
interface AutomationRun {
  id: string;
  ruleId: string;
  ruleName: string;
  state: string;
  createdAt: string;
  actionKind: string | null;
  /** AUTO-006: server-computed — true only while the run is `succeeded`, its action kind is undoable
   * (`add_task`/`add_calendar_event`, never `notify`), and the 5-minute undo window hasn't closed yet. */
  canUndo: boolean;
  /** ISO timestamp of when the undo window closes, when `canUndo` is (or recently was) true — used only
   * for the optional "Xm left" countdown label; the server re-checks the real deadline on every request. */
  undoExpiresAt: string | null;
}
interface PreparedAction {
  id: string;
  runId: string;
  title: string;
  steps: string[];
  sourceNote: string | null;
  merchantName: string | null;
  state: "pending_confirmation" | "confirmed_done" | "dismissed";
  createdAt: string;
}

// Mirrors the full spec §40.3 automation-run state chain (triggered → evaluating → skipped/
// approval_required/authorized → executing → succeeded/partially_succeeded/failed/rolled_back/canceled) —
// see AutomationService's own top-of-file doc comment for which of these are genuinely reachable today.
// `evaluating` and `triggered` are included for completeness even though a client almost never observes
// them in practice (the server resolves a run past `evaluating` before the same request that created it
// returns), and `partially_succeeded` is included even though nothing can produce it yet (this codebase's
// rule model is strictly one action per rule) — labeling an enum value correctly costs nothing, unlike
// pretending backend logic exists to produce it.
const RUN_STATE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  triggered: "neutral",
  evaluating: "neutral",
  skipped: "neutral",
  approval_required: "warning",
  authorized: "neutral",
  executing: "neutral",
  succeeded: "positive",
  partially_succeeded: "warning",
  failed: "critical",
  rolled_back: "neutral",
  canceled: "neutral",
};

// Honest, human labels for each run state — "skipped" in particular must say *why* rather than showing the
// bare enum value, since a user seeing "skipped" with no context has no way to tell it apart from a bug.
const RUN_STATE_LABEL: Record<string, string> = {
  triggered: "triggered",
  evaluating: "evaluating",
  skipped: "skipped — already handled",
  approval_required: "waiting for approval",
  authorized: "authorized",
  executing: "running",
  succeeded: "succeeded",
  partially_succeeded: "partially succeeded — some actions failed",
  failed: "failed",
  rolled_back: "rolled back — undone after running",
  canceled: "canceled before running",
};

function runStateLabel(state: string): string {
  return RUN_STATE_LABEL[state] ?? state.replace(/_/g, " ");
}

/** "Undo (4m left)" — floors to whole minutes, "<1m left" once inside the last minute rather than
 * rounding down to "0m left" (which reads like it's already expired). */
function minutesLeftLabel(undoExpiresAt: string): string {
  const msLeft = new Date(undoExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "";
  const minutes = Math.floor(msLeft / 60_000);
  return minutes >= 1 ? `${minutes}m left` : "<1m left";
}

// L0 (notify-only) can't touch anything outside Veynlo; L1 (every other action kind) can, so it's flagged
// rather than shown identically to L0 — a flat "neutral" here made every rule look equally low-stakes
// regardless of what it actually does. L2 (prepare_cancellation) is flagged more strongly still: it's the
// only kind that stages a real, merchant-specific "go do this yourself" action.
const RISK_TIER_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  L0: "neutral",
  L1: "warning",
  L2: "critical",
};

function describeTrigger(trigger: TriggerDescriptor | null): string {
  if (!trigger) return "";
  const parts = [trigger.kind.replace(/^new_/, "New ").replace(/_/g, " ")];
  if (trigger.merchantContains) parts.push(`from "${trigger.merchantContains}"`);
  if (trigger.minAmountMinorUnits != null) parts.push(`over $${(trigger.minAmountMinorUnits / 100).toFixed(2)}`);
  if (trigger.maxAmountMinorUnits != null) parts.push(`under $${(trigger.maxAmountMinorUnits / 100).toFixed(2)}`);
  return parts.join(" ");
}

function describeAction(action: ActionDescriptor | null): string {
  if (!action) return "";
  if (action.kind === "notify") return `Notify: "${action.message ?? "default message"}"`;
  if (action.kind === "add_task") return `Add task: "${action.taskTitle ?? "default task"}"`;
  if (action.kind === "add_calendar_event") {
    const when = !action.daysFromNow ? "today" : `in ${action.daysFromNow} day${action.daysFromNow === 1 ? "" : "s"}`;
    return `Add calendar event: "${action.eventTitle ?? "default event"}" (${when})`;
  }
  if (action.kind === "prepare_cancellation") {
    return `Prepare cancellation steps: "${action.prepareCancellationTitle ?? "default title"}" — stages real steps for you to follow yourself, never cancels anything automatically`;
  }
  return action.kind;
}

/**
 * Phase 2 §52.2 "automation/rule center with safe suggest/prepare modes" — spec §34 AUTO-001's own
 * required UX: "Before activation, show trigger, conditions, action, scope, exceptions and examples in
 * plain English." A new rule's parsed trigger/action is shown immediately after creation for exactly that
 * reason, and every rule stays inspectable (not just at creation time) via `describeTrigger`/`describeAction`.
 */
export default function AutomationsPage() {
  const { data: rules, error: rulesError, isLoading: rulesLoading, mutate: mutateRules } = useSWR<AutomationRule[]>("/v1/automation/rules", swrFetcher);
  const { data: runs, mutate: mutateRuns } = useSWR<AutomationRun[]>("/v1/automation/runs", swrFetcher, { refreshInterval: 15_000 });
  const { data: preparedActions, mutate: mutatePrepared } = useSWR<PreparedAction[]>("/v1/automation/prepared-actions", swrFetcher, { refreshInterval: 15_000 });
  const { data: killSwitch, mutate: mutateKillSwitch } = useSWR<{ paused: boolean }>("/v1/automation/kill-switch", swrFetcher);
  const [ruleText, setRuleText] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [lastCreatedSummary, setLastCreatedSummary] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [undoingRunId, setUndoingRunId] = useState<string | null>(null);
  // Both fire from a bare Button onClick below — without a try/catch, a rejected approve (e.g. the kill
  // switch got turned on in another tab since this list last refreshed — AUTOMATIONS_PAUSED) or a
  // double-clicked reject (RUN_NOT_PENDING) became an unhandled promise rejection with no visible feedback,
  // same bug class this page's own undoRun already guards against.
  const [runActionError, setRunActionError] = useState<string | null>(null);
  const [preparedActionError, setPreparedActionError] = useState<string | null>(null);
  const [preparedActionBusyId, setPreparedActionBusyId] = useState<string | null>(null);

  async function toggleKillSwitch(paused: boolean) {
    mutateKillSwitch({ paused }, false);
    await api.put("/v1/automation/kill-switch", { paused });
    mutateKillSwitch();
  }

  async function createRule(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    setLastCreatedSummary(null);
    try {
      const result = await api.post<{ id: string; summary: string }>("/v1/automation/rules", { naturalLanguageSource: ruleText });
      setLastCreatedSummary(result.summary);
      setRuleText("");
      mutateRules();
    } catch (err) {
      setCreateError(
        err instanceof ApiError && err.code === "AI_NOT_CONFIGURED"
          ? "Automation rules need AI configured on this deployment."
          : err instanceof ApiError
            ? err.message
            : "Couldn't create that rule. Try rephrasing it.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(rule: AutomationRule) {
    await api.put(`/v1/automation/rules/${rule.id}`, { enabled: !rule.enabled });
    mutateRules();
  }

  async function toggleApprovalMode(rule: AutomationRule) {
    await api.put(`/v1/automation/rules/${rule.id}`, {
      approvalMode: rule.approvalMode === "auto_low_risk" ? "confirm_each_time" : "auto_low_risk",
    });
    mutateRules();
  }

  async function deleteRule(id: string, name: string) {
    if (!window.confirm(`Delete "${name}"? Its trigger and action stop firing immediately — this can't be undone.`)) return;
    await api.delete(`/v1/automation/rules/${id}`);
    mutateRules();
    // Deleting a rule cascades to its runs server-side, but the runs list isn't otherwise
    // revalidated here — without this, a deleted rule's past runs kept showing in "Recent
    // activity" until the next 15s auto-refresh or a full page reload (confirmed live: a run
    // stayed visible immediately after delete, then vanished only on reload).
    mutateRuns();
  }

  async function approveRun(id: string) {
    setRunActionError(null);
    try {
      await api.post(`/v1/automation/runs/${id}/approve`);
      mutateRuns();
      // Approving an L2 "prepare_cancellation" run stages a new prepared action — refresh that list too so
      // it shows up without waiting for the next 15s poll.
      mutatePrepared();
    } catch (err) {
      setRunActionError(
        err instanceof ApiError && err.code === "AUTOMATIONS_PAUSED"
          ? "Automations are paused — turn off the kill switch above before approving this run."
          : err instanceof ApiError
            ? err.message
            : "Couldn't approve this run. Please try again.",
      );
      mutateRuns();
    }
  }

  async function rejectRun(id: string) {
    setRunActionError(null);
    try {
      await api.post(`/v1/automation/runs/${id}/reject`);
      mutateRuns();
    } catch (err) {
      setRunActionError(err instanceof ApiError ? err.message : "Couldn't dismiss this run. Please try again.");
      mutateRuns();
    }
  }

  async function undoRun(id: string) {
    setUndoError(null);
    setUndoingRunId(id);
    try {
      await api.post(`/v1/automation/runs/${id}/undo`);
      mutateRuns();
    } catch (err) {
      // Not silent: window-expired (or already-undone, or a notify run) races are real — the run list
      // only refreshes every 15s, so a click just past the 5-minute mark, or a second tab's undo landing
      // first, must surface a clear message rather than the button just quietly doing nothing.
      setUndoError(
        err instanceof ApiError && err.code === "UNDO_WINDOW_EXPIRED"
          ? "The undo window for this run has expired."
          : err instanceof ApiError
            ? err.message
            : "Couldn't undo this run. Please try again.",
      );
      mutateRuns();
    } finally {
      setUndoingRunId(null);
    }
  }

  async function confirmPreparedAction(id: string) {
    setPreparedActionError(null);
    setPreparedActionBusyId(id);
    try {
      await api.post(`/v1/automation/prepared-actions/${id}/confirm`);
      mutatePrepared();
    } catch (err) {
      setPreparedActionError(err instanceof ApiError ? err.message : "Couldn't confirm this. Please try again.");
    } finally {
      setPreparedActionBusyId(null);
    }
  }

  async function dismissPreparedAction(id: string) {
    setPreparedActionError(null);
    setPreparedActionBusyId(id);
    try {
      await api.post(`/v1/automation/prepared-actions/${id}/dismiss`);
      mutatePrepared();
    } catch (err) {
      setPreparedActionError(err instanceof ApiError ? err.message : "Couldn't dismiss this. Please try again.");
    } finally {
      setPreparedActionBusyId(null);
    }
  }

  const pendingPreparedActions = (preparedActions ?? []).filter((p) => p.state === "pending_confirmation");
  const pendingRuns = (runs ?? []).filter((r) => r.state === "approval_required");
  const pastRuns = (runs ?? []).filter((r) => r.state !== "approval_required");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Automations</h1>
        <p className="mt-1 text-sm text-tertiary">
          Describe a rule in plain English. New rules ask for your approval each time by default — turn on
          auto-run once you trust one.
        </p>
      </header>

      <Card>
        <CardBody>
          {/* `?? false` while killSwitch is still loading meant a paused account briefly rendered this
              security kill switch as "off" on every page load, before snapping to its real "on" state a
              moment later — misleading for a control the description calls out as safety-relevant.
              Disabled (not just defaulted) until the real value is known. */}
          <Switch
            id="automations-kill-switch"
            checked={killSwitch ? killSwitch.paused : false}
            onCheckedChange={toggleKillSwitch}
            disabled={!killSwitch}
            label="Pause all automations"
            description="Immediately stops every rule from running or creating new approvals — a security kill switch, not per-rule control."
          />
        </CardBody>
      </Card>

      {killSwitch?.paused && (
        <p className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          Automations are paused. No rule will run until you turn this back on.
        </p>
      )}

      <Card>
        <CardBody className="space-y-3">
          <form onSubmit={createRule} className="space-y-3">
            <div>
              <Label htmlFor="rule-text">New rule</Label>
              <Input
                id="rule-text"
                placeholder="e.g. Notify me if a Comcast bill is over $150"
                value={ruleText}
                onChange={(e) => setRuleText(e.target.value)}
                maxLength={500}
                required
              />
            </div>
            <FieldError>{createError ?? undefined}</FieldError>
            <Button type="submit" loading={creating} disabled={!ruleText.trim()}>
              Create rule
            </Button>
          </form>
          {lastCreatedSummary && (
            <p className="rounded-lg bg-positive-subtle px-3 py-2 text-sm text-positive-subtle-text">{lastCreatedSummary}</p>
          )}
        </CardBody>
      </Card>

      {pendingRuns.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Waiting for your approval</h2>
          {runActionError && <FieldError>{runActionError}</FieldError>}
          <div className="space-y-3">
            {pendingRuns.map((run) => (
              <Card key={run.id}>
                <CardBody className="flex items-center justify-between gap-4">
                  <p className="min-w-0 break-words text-[0.9375rem] font-medium text-primary">{run.ruleName}</p>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => approveRun(run.id)}>
                      Approve
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => rejectRun(run.id)}>
                      Dismiss
                    </Button>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      )}

      {pendingPreparedActions.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Prepared for you</h2>
          {preparedActionError && <FieldError>{preparedActionError}</FieldError>}
          <div className="space-y-3">
            {pendingPreparedActions.map((prepared) => (
              // Deliberately distinct from a plain task card — a left accent bar plus an explicit "Prepared
              // for you" badge, since this bundles real merchant steps and needs a one-tap confirmation a
              // plain reminder task never asks for. Never implies Veynlo did the cancellation itself.
              <Card key={prepared.id} className="border-l-4 border-critical">
                <CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="mb-1 flex items-center gap-2">
                        <Badge tone="critical">Prepared for you</Badge>
                        {prepared.merchantName && <span className="text-xs text-tertiary">{prepared.merchantName}</span>}
                      </div>
                      <p className="break-words text-[0.9375rem] font-medium text-primary">{prepared.title}</p>
                      <p className="mt-1 text-xs text-tertiary">
                        Veynlo staged these real steps — it hasn&apos;t cancelled anything. Follow them yourself, then confirm below.
                      </p>
                    </div>
                  </div>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-primary">
                    {prepared.steps.map((step, i) => (
                      <li key={i} className="break-words">
                        {step}
                      </li>
                    ))}
                  </ol>
                  {prepared.sourceNote && <p className="text-xs italic text-tertiary">{prepared.sourceNote}</p>}
                  <div className="flex gap-2 border-t border-border-subtle pt-3">
                    <Button size="sm" loading={preparedActionBusyId === prepared.id} onClick={() => confirmPreparedAction(prepared.id)}>
                      I&apos;ve done this
                    </Button>
                    <Button size="sm" variant="ghost" loading={preparedActionBusyId === prepared.id} onClick={() => dismissPreparedAction(prepared.id)}>
                      Not doing this
                    </Button>
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Your rules</h2>
        {rulesLoading && <div className="h-20 animate-pulse rounded-xl bg-subtle" />}
        {!rulesLoading && rulesError && !rules && (
          <FetchError what="your automations" message={rulesError instanceof ApiError ? rulesError.message : undefined} onRetry={() => mutateRules()} />
        )}
        {!rulesLoading && !rulesError && rules?.length === 0 && (
          <EmptyState title="No automations yet" description="Create one above — Veynlo will show you exactly what it plans to do before it runs." />
        )}
        {rules && rules.length > 0 && (
          <div className="space-y-3">
            {rules.map((rule) => (
              <Card key={rule.id}>
                <CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="break-words text-[0.9375rem] font-medium text-primary">{rule.name}</p>
                      <p className="mt-1 break-words text-sm text-tertiary">
                        When {describeTrigger(rule.trigger)} → {describeAction(rule.action)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge tone={RISK_TIER_TONE[rule.riskTier] ?? "neutral"}>{rule.riskTier}</Badge>
                      <Button variant="ghost" size="sm" onClick={() => deleteRule(rule.id, rule.name)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1 border-t border-border-subtle pt-3">
                    <Switch id={`enabled-${rule.id}`} label="Enabled" checked={rule.enabled} onCheckedChange={() => toggleEnabled(rule)} />
                    <Switch
                      id={`auto-${rule.id}`}
                      label="Run automatically"
                      description="Off (default): each run waits for your approval. On: runs immediately when triggered."
                      checked={rule.approvalMode === "auto_low_risk"}
                      onCheckedChange={() => toggleApprovalMode(rule)}
                    />
                  </div>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      {pastRuns.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Recent activity</h2>
          {undoError && <FieldError>{undoError}</FieldError>}
          <div className="space-y-2">
            {pastRuns.slice(0, 20).map((run) => (
              <div key={run.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2 text-sm">
                <span className="min-w-0 break-words text-primary">{run.ruleName}</span>
                <div className="flex shrink-0 items-center gap-2">
                  {run.canUndo && (
                    <Button size="sm" variant="ghost" loading={undoingRunId === run.id} onClick={() => undoRun(run.id)}>
                      {run.undoExpiresAt && minutesLeftLabel(run.undoExpiresAt) ? `Undo (${minutesLeftLabel(run.undoExpiresAt)})` : "Undo"}
                    </Button>
                  )}
                  <Badge tone={RUN_STATE_TONE[run.state] ?? "neutral"}>{runStateLabel(run.state)}</Badge>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
