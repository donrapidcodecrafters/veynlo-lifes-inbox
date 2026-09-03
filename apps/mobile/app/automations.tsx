import { useCallback, useState } from "react";
import { RefreshControl, Switch, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";

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
  riskTier: string;
  approvalMode: "confirm_each_time" | "auto_low_risk";
  enabled: boolean;
  trigger: TriggerDescriptor | null;
  action: ActionDescriptor | null;
}
interface AutomationRun {
  id: string;
  ruleName: string;
  state: string;
  actionKind: string | null;
  /** AUTO-006: server-computed — see apps/web's mirror of this same field for the full rationale. */
  canUndo: boolean;
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
}

// Mirrors apps/web's RUN_STATE_TONE — the full spec §40.3 automation-run state chain (triggered →
// evaluating → skipped/approval_required/authorized → executing → succeeded/partially_succeeded/failed/
// rolled_back/canceled). See AutomationService's own top-of-file doc comment for which of these are
// genuinely reachable today (`evaluating`/`triggered` resolve before a client ever polls in practice, and
// `partially_succeeded` can't be produced yet since this codebase's rule model is strictly one action per
// rule) — labeling every enum value correctly costs nothing, unlike pretending backend logic exists for it.
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

// Honest, human labels — "skipped" in particular must say *why* rather than showing the bare enum value.
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

// Mirrors apps/web's RISK_TIER_TONE — L0 (notify-only) can't touch anything outside Veynlo; L1 (every
// other action kind: add_task/add_calendar_event) can, so it's flagged rather than shown identically to
// L0. Found live: this screen previously hardcoded every rule's risk badge to "neutral" regardless of
// riskTier, silently losing the exact signal web's own version of this badge exists to show.
const RISK_TIER_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  L0: "neutral",
  L1: "warning",
  L2: "critical",
};

function minutesLeftLabel(undoExpiresAt: string): string {
  const msLeft = new Date(undoExpiresAt).getTime() - Date.now();
  if (msLeft <= 0) return "";
  const minutes = Math.floor(msLeft / 60_000);
  return minutes >= 1 ? `${minutes}m left` : "<1m left";
}

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
    return `Prepare cancellation steps: "${action.prepareCancellationTitle ?? "default title"}" — stages real steps for you to follow, never cancels anything automatically`;
  }
  return action.kind;
}

/** Mirrors apps/web's (app)/automations/page.tsx — see its own doc comment for the spec §34 AUTO-001
 * "plain English before activation" requirement this UI satisfies on both platforms. */
export default function AutomationsScreen() {
  const { theme } = useAppTheme();
  const [rules, setRules] = useState<AutomationRule[] | null>(null);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [preparedActions, setPreparedActions] = useState<PreparedAction[]>([]);
  const [preparedActionBusyId, setPreparedActionBusyId] = useState<string | null>(null);
  const [killSwitchPaused, setKillSwitchPaused] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [ruleText, setRuleText] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [lastCreatedSummary, setLastCreatedSummary] = useState<string | null>(null);
  // Found live: toggleKillSwitch/toggleEnabled/toggleApprovalMode/deleteRule/approveRun/rejectRun below all
  // fired an api call from a bare onPress/onValueChange with no try/catch — a failed request became an
  // unhandled promise rejection (React Native Web's full-screen crash overlay), same bug class already
  // fixed on this screen's own load(). Particularly bad here since toggleKillSwitch is a security control:
  // a failed PUT left the Switch showing "paused" with no indication the server never actually got it.
  const [actionError, setActionError] = useState<string | null>(null);
  // Found live: "Delete" on a rule fired deleteRule immediately on one tap — no confirmation at all,
  // inconsistent with every other destructive action in this app (connections.tsx, documents.tsx,
  // list/[id].tsx).
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [undoingRunId, setUndoingRunId] = useState<string | null>(null);

  // An unguarded fetch called fire-and-forget from useFocusEffect becomes an unhandled promise rejection
  // on any transient network failure — confirmed live elsewhere in this app (documents.tsx, lists.tsx) to
  // surface as a full-screen "Uncaught Error" overlay under react-native-web, not just a failed refresh.
  const load = useCallback(async () => {
    try {
      setRules(await api.get<AutomationRule[]>("/v1/automation/rules"));
      setRuns(await api.get<AutomationRun[]>("/v1/automation/runs"));
      setPreparedActions(await api.get<PreparedAction[]>("/v1/automation/prepared-actions"));
      setKillSwitchPaused((await api.get<{ paused: boolean }>("/v1/automation/kill-switch")).paused);
    } catch {
      // Best-effort refresh — whatever's already in state stays visible rather than blanking the screen.
    }
  }, []);

  async function toggleKillSwitch(paused: boolean) {
    setKillSwitchPaused(paused);
    setActionError(null);
    try {
      await api.put("/v1/automation/kill-switch", { paused });
    } catch (err) {
      setKillSwitchPaused(!paused);
      setActionError(err instanceof ApiError ? err.message : "Couldn't update the kill switch. Please try again.");
    }
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function createRule() {
    setCreating(true);
    setCreateError(null);
    setLastCreatedSummary(null);
    try {
      const result = await api.post<{ summary: string }>("/v1/automation/rules", { naturalLanguageSource: ruleText });
      setLastCreatedSummary(result.summary);
      setRuleText("");
      await load();
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
    setActionError(null);
    try {
      await api.put(`/v1/automation/rules/${rule.id}`, { enabled: !rule.enabled });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this rule. Please try again.");
    }
  }

  async function toggleApprovalMode(rule: AutomationRule) {
    setActionError(null);
    try {
      await api.put(`/v1/automation/rules/${rule.id}`, {
        approvalMode: rule.approvalMode === "auto_low_risk" ? "confirm_each_time" : "auto_low_risk",
      });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this rule. Please try again.");
    }
  }

  async function deleteRule(id: string) {
    setActionError(null);
    try {
      await api.delete(`/v1/automation/rules/${id}`);
      setConfirmingDeleteId(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't delete this rule. Please try again.");
    }
  }

  async function approveRun(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/automation/runs/${id}/approve`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't approve this run. Please try again.");
    }
  }

  async function rejectRun(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/automation/runs/${id}/reject`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't dismiss this run. Please try again.");
    }
  }

  async function undoRun(id: string) {
    setActionError(null);
    setUndoingRunId(id);
    try {
      await api.post(`/v1/automation/runs/${id}/undo`);
      await load();
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.code === "UNDO_WINDOW_EXPIRED"
          ? "The undo window for this run has expired."
          : err instanceof ApiError
            ? err.message
            : "Couldn't undo this run. Please try again.",
      );
      await load();
    } finally {
      setUndoingRunId(null);
    }
  }

  async function confirmPreparedAction(id: string) {
    setActionError(null);
    setPreparedActionBusyId(id);
    try {
      await api.post(`/v1/automation/prepared-actions/${id}/confirm`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't confirm this. Please try again.");
    } finally {
      setPreparedActionBusyId(null);
    }
  }

  async function dismissPreparedAction(id: string) {
    setActionError(null);
    setPreparedActionBusyId(id);
    try {
      await api.post(`/v1/automation/prepared-actions/${id}/dismiss`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't dismiss this. Please try again.");
    } finally {
      setPreparedActionBusyId(null);
    }
  }

  const pendingPreparedActions = preparedActions.filter((p) => p.state === "pending_confirmation");
  const pendingRuns = runs.filter((r) => r.state === "approval_required");
  const pastRuns = runs.filter((r) => r.state !== "approval_required");

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader
        title="Automations"
        subtitle="Describe a rule in plain English. New rules ask for your approval each time by default."
      />

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Pause all automations</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
            Immediately stops every rule from running — a security kill switch, not per-rule control.
          </Text>
        </View>
        <Switch
          value={killSwitchPaused}
          onValueChange={toggleKillSwitch}
          accessibilityLabel="Pause all automations"
          trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
          {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
        />
      </Card>

      {killSwitchPaused && (
        <Text style={{ fontSize: 13, color: theme.colors.warning, backgroundColor: theme.colors.warningSubtleBg, padding: 10, borderRadius: theme.radius.md }}>
          Automations are paused. No rule will run until you turn this back on.
        </Text>
      )}

      <Card style={{ gap: 10 }}>
        <TextField label="New rule" placeholder="e.g. Notify me if a Comcast bill is over $150" value={ruleText} onChangeText={setRuleText} />
        {createError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{createError}</Text>}
        <Button onPress={createRule} loading={creating} disabled={!ruleText.trim()}>
          Create rule
        </Button>
        {lastCreatedSummary && <Text style={{ fontSize: 13, color: theme.colors.positiveSubtleText }}>{lastCreatedSummary}</Text>}
      </Card>

      {pendingRuns.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Waiting for your approval
          </Text>
          {pendingRuns.map((run) => (
            <Card key={run.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary, flex: 1 }}>{run.ruleName}</Text>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Button onPress={() => approveRun(run.id)}>Approve</Button>
                <Button variant="ghost" onPress={() => rejectRun(run.id)}>
                  Dismiss
                </Button>
              </View>
            </Card>
          ))}
        </View>
      )}

      {pendingPreparedActions.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Prepared for you</Text>
          {pendingPreparedActions.map((prepared) => (
            // Deliberately distinct from a plain task card — a left accent bar plus an explicit "Prepared
            // for you" badge, since this bundles real merchant steps and needs a one-tap confirmation a
            // plain reminder task never asks for. Never implies Veynlo did the cancellation itself.
            <Card key={prepared.id} style={{ gap: 10, borderLeftWidth: 4, borderLeftColor: theme.colors.critical }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Badge tone="critical">Prepared for you</Badge>
                {prepared.merchantName && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{prepared.merchantName}</Text>}
              </View>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{prepared.title}</Text>
              <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                Veynlo staged these real steps — it hasn&apos;t cancelled anything. Follow them yourself, then confirm below.
              </Text>
              <View style={{ gap: 4 }}>
                {prepared.steps.map((step, i) => (
                  <Text key={i} style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                    {i + 1}. {step}
                  </Text>
                ))}
              </View>
              {prepared.sourceNote && (
                <Text style={{ fontSize: 11, fontStyle: "italic", color: theme.colors.textTertiary }}>{prepared.sourceNote}</Text>
              )}
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button onPress={() => confirmPreparedAction(prepared.id)} loading={preparedActionBusyId === prepared.id}>
                  I&apos;ve done this
                </Button>
                <Button variant="ghost" onPress={() => dismissPreparedAction(prepared.id)} loading={preparedActionBusyId === prepared.id}>
                  Not doing this
                </Button>
              </View>
            </Card>
          ))}
        </View>
      )}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Your rules</Text>
        {rules?.length === 0 && (
          <EmptyState title="No automations yet" description="Create one above — Veynlo will show you exactly what it plans to do before it runs." />
        )}
        {rules?.map((rule) => (
          <Card key={rule.id} style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{rule.name}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
                  When {describeTrigger(rule.trigger)} → {describeAction(rule.action)}
                </Text>
              </View>
              <Badge tone={RISK_TIER_TONE[rule.riskTier] ?? "neutral"}>{rule.riskTier}</Badge>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>Enabled</Text>
              {/* `activeThumbColor` (RNW-only, not in RN's typed SwitchProps — harmlessly ignored on native)
                  keeps the web preview's ON-state thumb on-brand: `trackColor` alone left the track purple
                  but the thumb defaulting to react-native-web's hardcoded teal, confirmed live. */}
              <Switch
                value={rule.enabled}
                onValueChange={() => toggleEnabled(rule)}
                accessibilityLabel={`Enabled: ${rule.name}`}
                trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
              />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>Run automatically</Text>
                <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Off waits for your approval each time.</Text>
              </View>
              <Switch
                value={rule.approvalMode === "auto_low_risk"}
                onValueChange={() => toggleApprovalMode(rule)}
                accessibilityLabel={`Run automatically: ${rule.name}`}
                trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
              />
            </View>
            {confirmingDeleteId !== rule.id && (
              <Button variant="ghost" onPress={() => setConfirmingDeleteId(rule.id)}>
                Delete
              </Button>
            )}
            {confirmingDeleteId === rule.id && (
              <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
                  Delete &quot;{rule.name}&quot;? This can&apos;t be undone.
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button onPress={() => deleteRule(rule.id)}>Confirm delete</Button>
                  <Button variant="ghost" onPress={() => setConfirmingDeleteId(null)}>
                    Cancel
                  </Button>
                </View>
              </View>
            )}
          </Card>
        ))}
      </View>

      {pastRuns.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Recent activity</Text>
          {pastRuns.slice(0, 20).map((run) => (
            <View key={run.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 4, gap: 8 }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{run.ruleName}</Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {run.canUndo && (
                  <Button variant="ghost" onPress={() => undoRun(run.id)} loading={undoingRunId === run.id}>
                    {run.undoExpiresAt && minutesLeftLabel(run.undoExpiresAt) ? `Undo (${minutesLeftLabel(run.undoExpiresAt)})` : "Undo"}
                  </Button>
                )}
                <Badge tone={RUN_STATE_TONE[run.state] ?? "neutral"}>{runStateLabel(run.state)}</Badge>
              </View>
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}
