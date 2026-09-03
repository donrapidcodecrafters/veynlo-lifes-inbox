import { forwardRef, ForbiddenException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateId, type AutomationRunState } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { MODEL_PROVIDER, type ModelProvider } from "../intelligence/model-provider.interface";
import type { StructuredExtractionResult } from "../intelligence/anthropic-extraction.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { ScheduleService } from "../schedule/schedule.service";
// `import type` deliberately, not a value import: CalendarWriteBackService (via ConnectorsModule ->
// IngestionModule -> AutomationModule) sits on a genuine circular MODULE-GRAPH dependency (see
// automation.module.ts's forwardRef doc comment) that, at the plain JS-require level, becomes a real
// circular *file* dependency the moment this is a value import — confirmed live: booting the app crashed
// with "Cannot access 'IngestionService' before initialization" (a classic CommonJS TDZ symptom) via the
// chain ingestion.service.ts -> automation.service.ts -> calendar-write-back.service.ts ->
// google-calendar.adapter.ts -> ingestion.service.ts. A type-only import erases at compile time, so no such
// runtime `require` cycle exists — safe here specifically because the constructor below resolves this
// dependency via an explicit `@Inject(forwardRef(...))` TOKEN, not TypeScript's reflected parameter type,
// so nothing actually needs the class value at this call site.
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";
// Plain function import, not a NestJS provider — `resolveMerchantCancellationSteps` is a pure DB-read
// helper (see its own doc comment in merchant-cancellation-steps.ts), so this needs no module wiring and
// creates no cycle: that file imports only @veynlo/db/@veynlo/core, never anything from this module.
import { resolveMerchantCancellationSteps } from "../commerce/merchant-cancellation-steps";
import type { CreateRuleFromTextDto, UpdateRuleDto } from "./dto";
import {
  RuleParseResultSchema,
  TRIGGER_KIND_BY_CATEGORY,
  riskTierForAction,
  type ActionDescriptor,
  type RuleParseResult,
  type ActionKind,
  type TriggerDescriptor,
} from "./rule-schemas";

/** AUTO-006 "Undo / compensation" — spec §34.1's L0/L1 tiers call every automation action "reversible,
 * internal, always logged/undoable"; this is the fixed window after a run succeeds during which
 * `AutomationService.undoRun` accepts an undo. 5 minutes is long enough to notice a run that just fired
 * (the web/mobile "Recent activity" list polls every 15s) and react, without leaving a stale undo option
 * available indefinitely once the created task/event may already be visible or acted on elsewhere (the
 * Reminders list, the unified calendar). Chosen as a fixed product decision, not configurable per rule.
 */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

/** Only these two action kinds create a Veynlo-internal row (`tasks`/`calendar_events`) that can be
 * cleanly deleted. `notify` is deliberately excluded — by the time a run reaches "succeeded" its
 * notification has already been created/delivered, and there's no meaningful way to "un-notify" someone;
 * building a no-op undo button for it would be worse than not offering one. `prepare_cancellation` is also
 * excluded: its `preparedActions` row has its own dedicated "dismissed" state (see
 * `dismissPreparedAction`), which is the honest way to back out of one — not a generic run "undo" that
 * implies deleting evidence of what was prepared. */
const UNDOABLE_ACTION_KINDS = new Set<ActionKind>(["add_task", "add_calendar_event"]);

/** What `IngestionService.fileInboxItem` (the single point every domain extractor already funnels
 * through) hands to `evaluateEvent` — deliberately just the fields a trigger filter can match on, not a
 * reference to the underlying bill/purchase/etc. row, so this module stays decoupled from every other
 * domain schema. */
export interface AutomationTriggerEvent {
  ownerUserId: string;
  householdId: string | null;
  category: string;
  linkedResourceType: string;
  linkedResourceId: string;
  amountMinorUnits?: number | null;
  merchantLabel?: string | null;
}

function parseDescriptor<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Phase 2 §52.2 "automation/rule center with safe suggest/prepare modes" (spec §34 AUTO-001 / DEC-001).
 * Deliberately built on the existing two-table schema (`automation_rules`/`automation_runs`) rather than
 * the spec's full six-table model (`rule_versions`/`action_plans`/`approvals`/`action_executions` as
 * separate tables) — `automation_runs.state` already expresses the spec's own run state machine
 * (triggered → approval_required/authorized → executing → succeeded/failed/canceled) in one row per
 * attempt, and there is exactly one rule format today, so a separate versioning table has no second
 * version to distinguish yet.
 *
 * §40.3 "Representative state machines — Automation run" full chain audit (closing a confirmed gap: this
 * module previously only ever produced triggered/approval_required/authorized/executing/succeeded/failed/
 * canceled — `evaluating`/`skipped`/`partially_succeeded`/`rolled_back` never appeared anywhere).
 * `automation_runs.state` (`packages/db/src/schema/automation.ts`) is a plain `text` column, not a Postgres
 * enum, and `@veynlo/core`'s `AutomationRunStateSchema` (`packages/core/src/entities/automation.ts`) already
 * names the exact spec vocabulary this file now actually produces — so closing this gap needed zero schema
 * migration, only real service logic:
 *   - `evaluating` — genuinely persisted, not just instrumentation. `triggerRun` below inserts the run row
 *     in this state the moment a trigger match is confirmed, *before* it's known whether the (rule,
 *     resource) pair is a duplicate or which of skipped/approval_required/authorized it resolves to — a
 *     real (if usually brief) window spanning the row's own INSERT round-trip plus, for `prepare_cancellation`,
 *     an awaited merchant lookup. This is the literal spec ordering (triggered → evaluating → skipped/
 *     approval_required/authorized), not a synchronous check that never leaves memory.
 *   - `skipped` — a duplicate trigger for a (rule, resource) pair already covered by an existing run now
 *     produces its own visible run row (state `skipped`, `resultJson.reason: "duplicate_trigger"`) instead
 *     of the prior silent `return`. See `triggerRun`'s own doc comment for why this reuses the idempotency
 *     INSERT itself as the detection point, and why the skip row needs a distinct synthetic idempotency key.
 *     This module's rule model has no separate "guard condition" concept beyond the trigger's own merchant/
 *     amount filters (already checked before `triggerRun` is ever called in `evaluateEvent`), so duplicate
 *     detection is the only real skip cause today — documented here rather than inventing a second one.
 *   - `partially_succeeded` — **left honestly unreachable.** `rule-schemas.ts`'s own top-of-file doc comment
 *     is explicit that the trigger/action vocabulary is "deliberately small and closed": one `ActionDescriptor`
 *     per rule, always exactly one action per run (see `ActionDescriptorSchema` — a single object, never an
 *     array). Every action kind executes as one atomic operation (one notification, one task insert, one
 *     calendar-event insert, one prepared-action insert), so a run can only ever fully succeed or fully fail
 *     — there is no "some actions succeeded, others failed" outcome to report yet. Building execution
 *     machinery for a multi-action run shape that nothing in this codebase can actually author (natural-
 *     language rule creation only ever emits one action; `UpdateRuleDto` only toggles enabled/approvalMode)
 *     would be dead code exercised only by a contrived test, not a real capability — worse than leaving the
 *     state undriven. If multi-action rules become a real product surface, `partially_succeeded` is the
 *     natural terminal state for a mixed-outcome run, with a per-action result array in `resultJson` (not
 *     just an overall boolean) — but that's a genuine, separate feature addition, not this pass's job.
 *   - `rolled_back` — this is a *rename*, not a new concept: `undoRun` already deletes the Veynlo-internal
 *     row a succeeded `add_task`/`add_calendar_event` run created, it just used to call the resulting state
 *     `undone`, a name spec §40.3 never uses and `@veynlo/core`'s `AutomationRunStateSchema` never listed.
 *     Renamed to the spec's own `rolled_back` to close that naming gap — distinct from `canceled`, which
 *     `rejectRun` only ever applies to a run still `approval_required` (stopped *before* it executed).
 *     `UNDOABLE_ACTION_KINDS` already covers every actually-reversible action kind in today's closed
 *     vocabulary (`add_task`, `add_calendar_event`); `notify` (can't un-send a delivered notification) and
 *     `prepare_cancellation` (has its own honest confirm/dismiss state machine, not a generic delete-undo)
 *     were already correctly excluded with honest rejection messages — see `undoRun`'s own doc comment.
 */
@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(MODEL_PROVIDER) private readonly ai: ModelProvider,
    @Inject(NotificationDeliveryService) private readonly notifications: NotificationDeliveryService,
    // Routes `add_calendar_event` through the real manual-create path (ScheduleService.createEvent) instead
    // of a raw insert, so an automation-created event gets real CAL-003 conflict detection — see
    // executeRun's own doc comment on this branch for the full history of the gap this closes.
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
    // CalendarWriteBackService lives in ConnectorsModule, which (via IngestionModule) already imports
    // AutomationModule — injecting it back here closes a real module cycle
    // (AutomationModule -> ConnectorsModule -> IngestionModule -> AutomationModule), so both the module
    // import (automation.module.ts) and this injection use NestJS's documented forwardRef() resolution.
    // Used only by undoRun, to best-effort clean up a provider-pushed event before deleting its local row —
    // see undoRun's own doc comment.
    // A plain `forwardRef(() => CalendarWriteBackService)` would still need the class VALUE in scope, which
    // is exactly the top-level import the doc comment above avoids — this lazy `require()` inside the
    // deferred arrow function reads the real class off the module only once DI actually resolves this
    // provider (well after every module has finished its own initial `require`, so the CommonJS TDZ cycle
    // never triggers), while the `import type` above still gives this file's own type annotations real types.
    @Inject(forwardRef(() => (require("../connectors/calendar-write-back.service") as { CalendarWriteBackService: unknown }).CalendarWriteBackService))
    private readonly calendarWriteBack: CalendarWriteBackService,
  ) {}

  /** AUTO-001 "Turn 'always remind me 7 days before things like this' into an inspectable rule" — parses
   * free text into the closed trigger/action vocabulary (rule-schemas.ts), created disabled-by-default's
   * opposite: enabled, but always starting in the conservative `confirm_each_time` approval mode (see
   * `UpdateRuleDto` for how a user opts a specific rule into `auto_low_risk` afterward). */
  async createRuleFromText(userId: string, dto: CreateRuleFromTextDto) {
    if (!this.ai.isConfigured()) {
      throw new ServiceUnavailableException({
        code: "AI_NOT_CONFIGURED",
        message: "Automation rule creation needs AI configured on this deployment (ANTHROPIC_API_KEY).",
      });
    }
    // extractStructured re-throws real API-level failures (network error, rate limit, exhausted billing
    // credits, etc.) rather than swallowing them — every other caller in this codebase wraps the call in
    // its own try/catch for exactly that reason (e.g. MemoriesService.processClassification). This is the
    // one caller that's on a synchronous, directly user-facing request path (POST /v1/automation/rules), so
    // an uncaught throw here would surface as a raw, uncoded 500 instead of the same clean AI_UNAVAILABLE
    // message already used below for "model returned no result".
    let result: StructuredExtractionResult<RuleParseResult> | null;
    try {
      result = await this.ai.extractStructured({
        extractorName: "automation_rule_parse_v1",
        model: "reasoning",
        systemPrompt:
          "Parse this automation rule request into a structured trigger and action for Veynlo, a personal life-inbox app. " +
          "Only use the trigger kinds and action kinds the schema allows. The action kinds are: notify (send an " +
          "in-app notification), add_task (create a local Veynlo reminder task), add_calendar_event (create a local " +
          "Veynlo calendar entry, never a write to any connected external calendar), and prepare_cancellation — use " +
          "prepare_cancellation ONLY when the request is specifically about being reminded/helped to CANCEL a named " +
          "subscription or service (e.g. 'help me cancel Netflix if I forget', 'prepare cancellation steps for my " +
          "gym'); when you do, set the trigger's merchantContains to that merchant's name so the rule can resolve its " +
          "real cancellation steps later. prepare_cancellation never cancels anything itself — it only stages the " +
          "merchant's real cancellation steps for the user to follow themselves and confirm once done, so say that " +
          "plainly in the summary too. For any other out-of-vocabulary request (e.g. 'send an email', 'pay this " +
          "bill', 'place an order'), pick the closest safe equivalent from notify/add_task/add_calendar_event rather " +
          "than inventing a new one, and say so plainly in the summary. Write `summary` as a complete plain-English " +
          "sentence describing exactly what the rule will do, suitable for showing a user before they activate it.",
        userContent: dto.naturalLanguageSource,
        schema: RuleParseResultSchema,
        toolDescription: "Emit the parsed trigger, action, and plain-English summary for this automation rule.",
      });
    } catch (err) {
      this.logger.error(`automation_rule_parse_v1 call failed: ${String((err as Error)?.message ?? err)}`);
      throw new ServiceUnavailableException({ code: "AI_UNAVAILABLE", message: "Couldn't parse that rule right now. Please try again." });
    }
    if (!result) {
      throw new ServiceUnavailableException({ code: "AI_UNAVAILABLE", message: "Couldn't parse that rule right now. Please try again." });
    }

    const riskTier = riskTierForAction(result.data.action.kind);
    const id = generateId("automationRule");
    await this.db.insert(schema.automationRules).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      name: result.data.summary.slice(0, 120),
      naturalLanguageSource: dto.naturalLanguageSource,
      triggerDescriptor: JSON.stringify(result.data.trigger),
      actionDescriptor: JSON.stringify(result.data.action),
      riskTier,
      approvalMode: "confirm_each_time",
      enabled: true,
    });

    return { id, summary: result.data.summary, trigger: result.data.trigger, action: result.data.action, riskTier };
  }

  async listRules(userId: string) {
    const rows = await this.db
      .select()
      .from(schema.automationRules)
      .where(eq(schema.automationRules.ownerUserId, userId))
      .orderBy(desc(schema.automationRules.createdAt));
    return rows.map((row) => ({
      ...row,
      trigger: parseDescriptor<TriggerDescriptor | null>(row.triggerDescriptor, null),
      action: parseDescriptor<ActionDescriptor | null>(row.actionDescriptor, null),
    }));
  }

  /** AUTO-010 "Automation kill switch... pause all external actions immediately" — one account-wide
   * toggle rather than per-rule, so a compromised-account or "something's gone wrong" moment doesn't
   * require finding and disabling every rule individually. `notificationPreferences` always has exactly
   * one row per user (created at sign-up), so this is a plain update, never an insert. */
  async setKillSwitch(userId: string, paused: boolean): Promise<void> {
    const automationsPausedAt = paused ? new Date() : null;
    await this.db
      .insert(schema.notificationPreferences)
      .values({ userId, automationsPausedAt })
      .onConflictDoUpdate({ target: schema.notificationPreferences.userId, set: { automationsPausedAt } });
  }

  async getKillSwitchStatus(userId: string): Promise<{ paused: boolean }> {
    const [prefs] = await this.db
      .select({ automationsPausedAt: schema.notificationPreferences.automationsPausedAt })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId))
      .limit(1);
    return { paused: Boolean(prefs?.automationsPausedAt) };
  }

  private async ownedRule(ruleId: string, userId: string) {
    const [rule] = await this.db.select().from(schema.automationRules).where(eq(schema.automationRules.id, ruleId)).limit(1);
    if (!rule || rule.ownerUserId !== userId) throw new NotFoundException({ code: "RULE_NOT_FOUND", message: "Automation rule not found." });
    return rule;
  }

  async updateRule(ruleId: string, userId: string, dto: UpdateRuleDto) {
    const rule = await this.ownedRule(ruleId, userId);
    // §34.1 L2 "prepare_cancellation" is spec AUTO-003's "prepare by default" posture — staging real
    // cancellation steps is safe to run unattended, but the whole point is that a person reviews and
    // approves before Veynlo even stages something on their behalf. Unlike L0/L1 (already always-reversible
    // and internal, so auto-run was never a real risk), L2 must never be flippable into `auto_low_risk`.
    if (dto.approvalMode === "auto_low_risk" && rule.riskTier !== "L0" && rule.riskTier !== "L1") {
      throw new ForbiddenException({
        code: "APPROVAL_MODE_NOT_ALLOWED",
        message: "This automation's action always needs your explicit approval before it runs — it can't be set to run automatically.",
      });
    }
    const updates: Partial<typeof schema.automationRules.$inferInsert> = { updatedAt: new Date() };
    if (dto.enabled !== undefined) updates.enabled = dto.enabled;
    if (dto.approvalMode !== undefined) updates.approvalMode = dto.approvalMode;
    await this.db.update(schema.automationRules).set(updates).where(eq(schema.automationRules.id, ruleId));
  }

  async deleteRule(ruleId: string, userId: string): Promise<void> {
    await this.ownedRule(ruleId, userId);
    await this.db.delete(schema.automationRules).where(eq(schema.automationRules.id, ruleId));
  }

  async listRuns(userId: string) {
    const rules = await this.db.select({ id: schema.automationRules.id, name: schema.automationRules.name }).from(schema.automationRules).where(eq(schema.automationRules.ownerUserId, userId));
    if (rules.length === 0) return [];
    const ruleNameById = new Map(rules.map((r) => [r.id, r.name]));
    const runs = await this.db
      .select()
      .from(schema.automationRuns)
      .where(
        inArray(
          schema.automationRuns.ruleId,
          rules.map((r) => r.id),
        ),
      )
      .orderBy(desc(schema.automationRuns.createdAt));
    const now = Date.now();
    return runs.map((run) => {
      const action = run.commandsJson as ActionDescriptor | null;
      const actionKind = action?.kind ?? null;
      // AUTO-006: undoable only while (a) the action kind is one that created a deletable row, (b) it
      // actually recorded what it created (older pre-migration runs won't have this), and (c) it's still
      // within the fixed window. Computed server-side, not left to the client, so the "Undo" affordance
      // can't be shown/hidden based on a client clock that's out of sync with the server's.
      const undoEligible = run.state === "succeeded" && actionKind != null && UNDOABLE_ACTION_KINDS.has(actionKind) && Boolean(run.resultResourceId);
      const undoExpiresAt = undoEligible ? new Date(run.updatedAt.getTime() + UNDO_WINDOW_MS) : null;
      const canUndo = Boolean(undoExpiresAt && now < undoExpiresAt.getTime());
      return {
        ...run,
        ruleName: ruleNameById.get(run.ruleId) ?? "Automation rule",
        actionKind,
        canUndo,
        undoExpiresAt: undoExpiresAt ? undoExpiresAt.toISOString() : null,
      };
    });
  }

  /**
   * Called from `IngestionService.fileInboxItem` for every domain item filed — the single integration
   * point every existing (and future) extractor already passes through, so no per-extractor wiring is
   * needed as new domains are added. Matches active, enabled rules whose trigger kind + merchant/amount
   * filters fit this event, and either executes immediately (`approvalMode: "auto_low_risk"`) or files a
   * pending run for the user to approve (the default — §34.1 "prepare by default").
   */
  async evaluateEvent(event: AutomationTriggerEvent): Promise<void> {
    const triggerKind = TRIGGER_KIND_BY_CATEGORY[event.category];
    if (!triggerKind) return;

    // AUTO-010 kill switch — checked before any rule can match, so a paused account creates zero new
    // runs at all (not just skips execution of ones that would've matched).
    const [prefs] = await this.db
      .select({ automationsPausedAt: schema.notificationPreferences.automationsPausedAt })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, event.ownerUserId))
      .limit(1);
    if (prefs?.automationsPausedAt) return;

    const candidateRules = await this.db
      .select()
      .from(schema.automationRules)
      .where(and(eq(schema.automationRules.ownerUserId, event.ownerUserId), eq(schema.automationRules.enabled, true)));

    for (const rule of candidateRules) {
      const trigger = parseDescriptor<TriggerDescriptor | null>(rule.triggerDescriptor, null);
      if (!trigger || trigger.kind !== triggerKind) continue;
      if (trigger.merchantContains && !event.merchantLabel?.toLowerCase().includes(trigger.merchantContains.toLowerCase())) continue;
      if (trigger.minAmountMinorUnits != null && (event.amountMinorUnits == null || event.amountMinorUnits < trigger.minAmountMinorUnits)) continue;
      if (trigger.maxAmountMinorUnits != null && (event.amountMinorUnits == null || event.amountMinorUnits > trigger.maxAmountMinorUnits)) continue;

      // Isolated per rule — without this, one rule's triggerRun throwing (e.g. a transient DB error, or a
      // notification-delivery failure inside it) aborted the whole loop, silently skipping every OTHER
      // matching rule for this same event too. A household can have several rules matching one event (e.g.
      // separate "auto-file Amazon receipts" and "notify me about big purchases" rules both matching a
      // $200 Amazon order); one misbehaving rule shouldn't suppress the others. The outer caller
      // (IngestionService.fileInboxItem) already treats a thrown evaluateEvent as non-fatal and logs it, so
      // this doesn't change failure visibility — it only stops one bad rule from masking the rest.
      try {
        await this.triggerRun(rule, event);
      } catch (err) {
        this.logger.error(`Automation rule ${rule.id} failed to evaluate for event ${event.linkedResourceType}:${event.linkedResourceId}: ${String((err as Error)?.message ?? err)}`);
      }
    }
  }

  /**
   * §40.3 "Automation run: triggered → evaluating → skipped / approval_required / authorized → ...".
   * The event has already matched this rule's trigger kind + merchant/amount filters by the time
   * `evaluateEvent` calls this (that match IS the spec's "triggered" transition — it happens in memory,
   * against no row yet, so there's nothing to persist for it). What happens in here is the spec's
   * "evaluating" phase: deciding whether this exact (rule, resource) pair has already been handled
   * (idempotency), and if not, whether it needs approval or is authorized to auto-run.
   *
   * One run per (rule, resource) — a bill's second "update" email re-firing fileInboxItem for the same
   * linkedResourceId must not queue a second identical approval/execution. The real guarantee is the
   * `automation_runs_idempotency_idx` UNIQUE index + `onConflictDoNothing` below: two concurrent
   * `triggerRun` calls for the same (rule, resource) (realistic: several BullMQ queues here run with
   * concurrency > 1, and two separate source events — e.g. two "bill updated" emails — can legitimately
   * race for the same linkedResourceId) both attempt the same INSERT; Postgres serializes them via the
   * unique index (the loser's statement blocks until the winner commits, then sees the conflict), so only
   * one ever proceeds to executing/notifying.
   *
   * This INSERT is deliberately the run row's *first* write, in state `evaluating` — not `approval_required`
   * or `authorized` directly — because at the moment of insert we don't yet know which of those (or
   * `skipped`) this run resolves to: that requires the INSERT's own conflict result (idempotency) and, for
   * `prepare_cancellation`, an already-awaited merchant lookup. Making `evaluating` the row's real starting
   * state, then updating it once the outcome is known, is what makes this transient state genuinely
   * observable (a concurrent debug query mid-evaluation would see it) rather than a state that's only ever
   * claimed to exist in a comment.
   */
  private async triggerRun(rule: typeof schema.automationRules.$inferSelect, event: AutomationTriggerEvent): Promise<void> {
    const action = parseDescriptor<ActionDescriptor | null>(rule.actionDescriptor, null);
    if (!action) return; // corrupt/unparseable rule data — nothing to evaluate, not a real run attempt

    // §34.1 L2 "prepare_cancellation" — resolved once, here, so `approveRun` (which only has the rule and
    // run, not this event) can still find the right merchant's curated steps whenever the action finally
    // executes. Looked up exactly like `IngestionService.findOrCreateMerchant`'s exact-match lookup, minus
    // the "create" half — automation only ever reads the merchant reference table, never authors it.
    const triggerMerchantId =
      action.kind === "prepare_cancellation" && event.merchantLabel ? await this.resolveMerchantIdByLabel(event.merchantLabel) : null;

    const idempotencyKey = `${rule.id}:${event.linkedResourceType}:${event.linkedResourceId}`;
    const runId = generateId("automationRun");
    const inserted = await this.db
      .insert(schema.automationRuns)
      .values({
        id: runId,
        ruleId: rule.id,
        triggerEvidenceId: event.linkedResourceId,
        state: "evaluating" satisfies AutomationRunState,
        idempotencyKey,
        commandsJson: action,
        triggerMerchantId,
      })
      .onConflictDoNothing({ target: schema.automationRuns.idempotencyKey })
      .returning({ id: schema.automationRuns.id });

    if (inserted.length === 0) {
      // AUTO-004 idempotency, made visible: this exact (rule, resource) pair already has a run (either it
      // committed already, or another concurrent call is committing it right now — either way the unique
      // index guarantees the row exists by the time this SELECT runs, per the ON CONFLICT blocking behavior
      // described above). Previously this just returned silently, so a merchant's "bill updated" email
      // arriving twice left zero trace of the second arrival ever having been evaluated. Now it produces its
      // own `skipped` run, for visibility/debugging — genuinely doing nothing (no notification, no
      // execution), so it needs its own idempotency key rather than reusing the original: the UNIQUE index's
      // real job is preventing a second *actionable* run for the same resource, and a `skipped` row that
      // never executes anything can't violate that guarantee no matter how many pile up.
      const [existingRun] = await this.db
        .select({ id: schema.automationRuns.id })
        .from(schema.automationRuns)
        .where(eq(schema.automationRuns.idempotencyKey, idempotencyKey))
        .limit(1);
      await this.db.insert(schema.automationRuns).values({
        id: generateId("automationRun"),
        ruleId: rule.id,
        triggerEvidenceId: event.linkedResourceId,
        state: "skipped" satisfies AutomationRunState,
        idempotencyKey: `${idempotencyKey}:skipped:${generateId("automationRun")}`,
        commandsJson: action,
        resultJson: { ok: true, reason: "duplicate_trigger", duplicateOfRunId: existingRun?.id ?? null },
        triggerMerchantId,
      });
      return;
    }

    const autoRun = rule.approvalMode === "auto_low_risk";
    await this.db
      .update(schema.automationRuns)
      .set({ state: (autoRun ? "authorized" : "approval_required") satisfies AutomationRunState, updatedAt: new Date() })
      .where(eq(schema.automationRuns.id, runId));

    if (autoRun) {
      await this.executeRun(runId, rule, action, event.ownerUserId, triggerMerchantId);
    } else {
      await this.notifications.createAndEnqueue({
        ownerUserId: event.ownerUserId,
        dedupeKey: `automation-approval:${runId}`,
        priority: "useful",
        title: `"${rule.name}" is ready to run`,
        body: "Review and approve this automation in Veynlo.",
      });
    }
  }

  /** Owner-checked approve — the only way an `approval_required` run reaches L0/L1 execution when the
   * rule's own approvalMode didn't already authorize it automatically.
   *
   * AUTO-010 kill switch — `evaluateEvent` already keeps a paused account from creating any *new* runs,
   * but that alone doesn't cover a run that was created (and left `approval_required`) *before* the user
   * paused: without this check here too, approving it would still execute the action, silently defeating
   * "pause all automation actions immediately." Checked fresh on every approve (not cached from whenever
   * the run was created) so flipping the kill switch mid-flight takes effect on the very next approve
   * attempt, and the run itself is left untouched (still `approval_required`) so approving again works
   * once the user turns automations back on. */
  async approveRun(runId: string, userId: string): Promise<void> {
    const { run, rule } = await this.ownedRun(runId, userId);
    if (run.state !== "approval_required") {
      throw new ForbiddenException({ code: "RUN_NOT_PENDING", message: "This automation run is no longer awaiting approval." });
    }
    const { paused } = await this.getKillSwitchStatus(userId);
    if (paused) {
      throw new ForbiddenException({ code: "AUTOMATIONS_PAUSED", message: "Automations are paused — turn off the kill switch before approving this run." });
    }
    const action = parseDescriptor<ActionDescriptor | null>(rule.actionDescriptor, null);
    if (!action) return;
    await this.db.update(schema.automationRuns).set({ state: "authorized", approvedByUserId: userId, updatedAt: new Date() }).where(eq(schema.automationRuns.id, runId));
    await this.executeRun(runId, rule, action, userId, run.triggerMerchantId);
  }

  async rejectRun(runId: string, userId: string): Promise<void> {
    const { run } = await this.ownedRun(runId, userId);
    if (run.state !== "approval_required") {
      throw new ForbiddenException({ code: "RUN_NOT_PENDING", message: "This automation run is no longer awaiting approval." });
    }
    await this.db.update(schema.automationRuns).set({ state: "canceled", updatedAt: new Date() }).where(eq(schema.automationRuns.id, runId));
  }

  private async ownedRun(runId: string, userId: string) {
    const [run] = await this.db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId)).limit(1);
    if (!run) throw new NotFoundException({ code: "RUN_NOT_FOUND", message: "Automation run not found." });
    const [rule] = await this.db.select().from(schema.automationRules).where(eq(schema.automationRules.id, run.ruleId)).limit(1);
    if (!rule || rule.ownerUserId !== userId) throw new NotFoundException({ code: "RUN_NOT_FOUND", message: "Automation run not found." });
    return { run, rule };
  }

  /** Exact-match lookup only — never creates a merchant row (automation reads the shared reference table,
   * it doesn't author it; only ingestion's own `findOrCreateMerchant` does that). Mirrors that lookup's
   * "an admin may have merged this exact merchant row into another one" handling, so a `prepare_cancellation`
   * rule keeps resolving correctly after an admin merchant merge. */
  private async resolveMerchantIdByLabel(displayName: string): Promise<string | null> {
    const [existing] = await this.db.select().from(schema.merchants).where(eq(schema.merchants.displayName, displayName)).limit(1);
    if (!existing) return null;
    return existing.mergedIntoMerchantId ?? existing.id;
  }

  private async executeRun(
    runId: string,
    rule: typeof schema.automationRules.$inferSelect,
    action: ActionDescriptor,
    ownerUserId: string,
    triggerMerchantId: string | null = null,
  ): Promise<void> {
    await this.db.update(schema.automationRuns).set({ state: "executing", updatedAt: new Date() }).where(eq(schema.automationRuns.id, runId));
    try {
      // AUTO-006: `resultResourceId` records exactly what got created, so `undoRun` knows exactly what to
      // delete later without re-deriving it from the action descriptor (which, for a task/event, isn't
      // enough on its own — several runs of the same rule create distinct rows with the same title).
      let resultResourceId: string | null = null;
      if (action.kind === "notify") {
        await this.notifications.createAndEnqueue({
          ownerUserId,
          dedupeKey: `automation-run:${runId}`,
          priority: "useful",
          title: rule.name,
          body: action.message ?? `Your automation "${rule.name}" just ran.`,
        });
      } else if (action.kind === "add_task") {
        const taskId = generateId("task");
        await this.db.insert(schema.tasks).values({
          id: taskId,
          ownerUserId,
          householdId: rule.householdId,
          title: action.taskTitle ?? rule.name,
          priority: "medium",
        });
        resultResourceId = taskId;
      } else if (action.kind === "add_calendar_event") {
        // CAL-003 "conflict detection ... whenever a new/edited event is saved" — this used to insert
        // directly into `calendar_events`, the ONLY calendar-event writer in this codebase that bypassed
        // `ScheduleService.createEvent` (the sole call site of `ConflictService.detectOverlaps` for a
        // manually/automation-created row — discovered events get their own separate CAL-003 backstop in
        // `IngestionService.extractCalendarEvent`). Confirmed live via an adversarial audit: an automation
        // event inserted exactly overlapping an existing one produced zero `schedule_conflicts` row.
        // Routing through `createEvent` fixes that and gives this branch the same real conflict list a
        // manual "add event" gets, at the cost of one behavior tightening worth naming: `createEvent`
        // verifies the acting user is an active member of `dto.householdId` when one is set (the raw insert
        // never checked this) — a household-scoped automation rule's owner not being a member of that
        // household any more is exactly the kind of state a rule should stop acting on, not silently work
        // around, so this is treated as a feature of routing through the real path, not a regression.
        const start = new Date();
        start.setDate(start.getDate() + (action.daysFromNow ?? 0));
        start.setHours(9, 0, 0, 0);
        const created = await this.schedule.createEvent(
          ownerUserId,
          {
            title: action.eventTitle ?? rule.name,
            startIso: start.toISOString(),
            isAllDay: false,
            householdId: rule.householdId,
          },
          "automation",
        );
        resultResourceId = created.id;
      } else if (action.kind === "prepare_cancellation") {
        // §34.1 L2 "prepare_cancellation" — reuses the exact same curated/user-corrected reference data
        // (and the same honest "nothing curated yet" precedent) the SUB-004 cancellation-assistant UI
        // already resolves informationally; automation adds nothing new here except staging it as a
        // dedicated, confirmable row instead of leaving it for the user to go find on demand. Deliberately
        // fails the run (same catch-and-record-failure path below, not a special-cased state) rather than
        // creating an empty/useless prepared action when nothing is curated for this merchant yet — a
        // `preparedActions` row promises real steps, never a placeholder.
        const resolved = await resolveMerchantCancellationSteps(this.db, triggerMerchantId, ownerUserId);
        if (!resolved) {
          throw new Error("No cancellation steps are known for this merchant yet, so nothing could be prepared.");
        }
        const preparedActionId = generateId("preparedAction");
        await this.db.insert(schema.preparedActions).values({
          id: preparedActionId,
          runId,
          ownerUserId,
          householdId: rule.householdId,
          merchantId: triggerMerchantId,
          title: action.prepareCancellationTitle ?? rule.name,
          steps: resolved.steps,
          sourceNote: resolved.sourceNote,
        });
        resultResourceId = preparedActionId;
      }
      await this.db
        .update(schema.automationRuns)
        .set({ state: "succeeded", resultJson: { ok: true }, resultResourceId, updatedAt: new Date() })
        .where(eq(schema.automationRuns.id, runId));
    } catch (err) {
      this.logger.error(`Automation run ${runId} failed: ${String(err)}`);
      await this.db
        .update(schema.automationRuns)
        .set({ state: "failed", resultJson: { ok: false, error: String((err as Error)?.message ?? err) }, updatedAt: new Date() })
        .where(eq(schema.automationRuns.id, runId));
    }
  }

  /** AUTO-006 "Undo / compensation" — reverses a succeeded `add_task`/`add_calendar_event` run within
   * `UNDO_WINDOW_MS` of execution by deleting the row `executeRun` created and marking the run
   * `rolled_back` (§40.3's own name for "a genuine post-execution reversal succeeded" — this used to be
   * called `undone`, a state neither the spec nor `@veynlo/core`'s `AutomationRunStateSchema` ever names;
   * renamed to close that gap. Deliberately distinct from `canceled`, which `rejectRun` only ever applies
   * to a run still `approval_required` — i.e. stopped *before* anything executed. A rolled-back run did
   * run, then got reversed; a canceled one never ran at all).
   * Reuses `ownedRun` (same ownership check `approveRun`/`rejectRun` already use) rather than a new access
   * pattern — only the rule's owner can undo one of its runs. `notify` runs and runs outside the window
   * are rejected with a specific error code, never silently no-op'd — same honesty standard for
   * `prepare_cancellation` below: it has its own real confirm/dismiss state machine, so a generic "undo"
   * here would either lie about reversing something already delivered to the user, or duplicate that
   * separate flow, so it's refused with an explicit redirect instead of a fake success.
   * `UNDOABLE_ACTION_KINDS` already covers every action kind in today's closed vocabulary that's actually
   * reversible this way — there is no third "other" reversible kind left unhandled to extend this to. */
  async undoRun(runId: string, userId: string): Promise<void> {
    const { run } = await this.ownedRun(runId, userId);
    if (run.state !== "succeeded") {
      throw new ForbiddenException({ code: "RUN_NOT_UNDOABLE", message: "Only a successfully executed run can be undone." });
    }
    const action = run.commandsJson as ActionDescriptor | null;
    if (!action || !UNDOABLE_ACTION_KINDS.has(action.kind) || !run.resultResourceId) {
      throw new ForbiddenException({
        code: "ACTION_NOT_UNDOABLE",
        message:
          action?.kind === "notify"
            ? "Notifications can't be undone — it's already been delivered."
            : action?.kind === "prepare_cancellation"
              ? "Prepared actions can't be undone this way — dismiss it instead from the prepared-actions list if you don't need it."
              : "This automation action can't be undone.",
      });
    }
    const elapsedMs = Date.now() - run.updatedAt.getTime();
    if (elapsedMs > UNDO_WINDOW_MS) {
      throw new ForbiddenException({ code: "UNDO_WINDOW_EXPIRED", message: "The undo window for this run has expired." });
    }

    // Atomically claim the run for undo before touching the resource it created. Two near-simultaneous
    // undo requests for the same run both pass every check above (they're read against the same
    // `run.state === "succeeded"` snapshot), so without a conditional write here both would proceed to
    // delete the same task/event and both would report success — not a corrupted end state for these two
    // idempotent DELETEs, but exactly the kind of double-fire a future non-idempotent undo (e.g. a
    // provider-side refund or write-back deletion) could not tolerate. The `state = "succeeded"` guard in
    // the WHERE clause means only the first caller's UPDATE actually matches a row; every other concurrent
    // (or already-undone) caller's UPDATE affects zero rows and is rejected with the same
    // `RUN_NOT_UNDOABLE` a plain re-undo already gets, rather than racing to also delete the resource.
    const claimed = await this.db
      .update(schema.automationRuns)
      .set({ state: "rolled_back" satisfies AutomationRunState, updatedAt: new Date() })
      .where(and(eq(schema.automationRuns.id, runId), eq(schema.automationRuns.state, "succeeded")))
      .returning({ id: schema.automationRuns.id });
    if (claimed.length === 0) {
      throw new ForbiddenException({ code: "RUN_NOT_UNDOABLE", message: "Only a successfully executed run can be undone." });
    }

    if (action.kind === "add_task") {
      await this.db.delete(schema.tasks).where(eq(schema.tasks.id, run.resultResourceId));
    } else if (action.kind === "add_calendar_event") {
      // AUTO-006/CAL-001 — an automation-created event `createEvent` (via the generic calendar-events
      // push endpoint, or a future automation "push to calendar" action) may since have been pushed to a
      // connected provider calendar, in which case a plain local delete would orphan it there forever
      // (confirmed via grep before this pass: neither calendar adapter had a `deleteEvent` at all). Routes
      // through `CalendarWriteBackService.deleteEvent`, which best-effort deletes the provider-side copy
      // first (log-and-continue on failure — see its own doc comment for why provider-side is
      // defense-in-depth, not the real boundary) and then deletes the local row itself, so this replaces
      // the plain `db.delete` below rather than running alongside it.
      await this.calendarWriteBack.deleteEvent({ eventId: run.resultResourceId, ownerUserId: userId });
    }
  }

  /** §34.1 L2 "prepare_cancellation" — everything staged for this user, newest first, with the merchant's
   * display name resolved for the UI (never the raw id). Honest by construction: every row here carries the
   * real `steps`/`sourceNote` `executeRun` snapshotted from `merchant-cancellation-steps.ts` — there is no
   * "prepared" row with placeholder content (see `executeRun`'s own doc comment on why that branch fails
   * the run instead of ever inserting one). */
  async listPreparedActions(userId: string) {
    const rows = await this.db
      .select()
      .from(schema.preparedActions)
      .where(eq(schema.preparedActions.ownerUserId, userId))
      .orderBy(desc(schema.preparedActions.createdAt));
    if (rows.length === 0) return [];
    const merchantIds = [...new Set(rows.map((r) => r.merchantId).filter((id): id is string => id != null))];
    const merchantRows = merchantIds.length
      ? await this.db.select({ id: schema.merchants.id, displayName: schema.merchants.displayName }).from(schema.merchants).where(inArray(schema.merchants.id, merchantIds))
      : [];
    const merchantNameById = new Map(merchantRows.map((m) => [m.id, m.displayName]));
    return rows.map((row) => ({ ...row, merchantName: row.merchantId ? (merchantNameById.get(row.merchantId) ?? null) : null }));
  }

  private async ownedPreparedAction(id: string, userId: string) {
    const [row] = await this.db.select().from(schema.preparedActions).where(eq(schema.preparedActions.id, id)).limit(1);
    if (!row || row.ownerUserId !== userId) throw new NotFoundException({ code: "PREPARED_ACTION_NOT_FOUND", message: "Prepared action not found." });
    return row;
  }

  /** The user's own one-tap "I went and did this" confirmation — the honest boundary this whole L2 tier is
   * built around: Veynlo staged the real steps, but only the user can attest the external cancellation
   * actually happened, since nothing here has any provider-side write access to verify it. One-way: rejects
   * unless the row is still `pending_confirmation`, so a confirmed (or dismissed) row can't be re-confirmed. */
  async confirmPreparedAction(id: string, userId: string): Promise<void> {
    const row = await this.ownedPreparedAction(id, userId);
    if (row.state !== "pending_confirmation") {
      throw new ForbiddenException({ code: "PREPARED_ACTION_NOT_PENDING", message: "This prepared action has already been confirmed or dismissed." });
    }
    await this.db.update(schema.preparedActions).set({ state: "confirmed_done", confirmedAt: new Date(), updatedAt: new Date() }).where(eq(schema.preparedActions.id, id));
  }

  /** The honest way to back out of a staged prepared action the user doesn't want (changed their mind, no
   * longer has the subscription, etc.) — distinct from `undoRun`, which only ever deletes a Veynlo-internal
   * row `executeRun` created; there is nothing to delete here, only a state to record. Same one-way
   * "must still be pending_confirmation" guard as `confirmPreparedAction`. */
  async dismissPreparedAction(id: string, userId: string): Promise<void> {
    const row = await this.ownedPreparedAction(id, userId);
    if (row.state !== "pending_confirmation") {
      throw new ForbiddenException({ code: "PREPARED_ACTION_NOT_PENDING", message: "This prepared action has already been confirmed or dismissed." });
    }
    await this.db.update(schema.preparedActions).set({ state: "dismissed", dismissedAt: new Date(), updatedAt: new Date() }).where(eq(schema.preparedActions.id, id));
  }
}
