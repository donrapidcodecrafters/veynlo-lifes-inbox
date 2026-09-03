import { z } from "zod";

/**
 * Phase 2 §52.2 "automation/rule center with safe suggest/prepare modes" (spec §34 AUTO-001
 * "natural-language rule creation" — "Turn 'always remind me 7 days before things like this' into an
 * inspectable rule"). The trigger/action vocabulary here is deliberately small and closed — every kind
 * maps to a category `IngestionService.fileInboxItem` already files (see `TRIGGER_KIND_BY_CATEGORY`).
 *
 * Every action kind is §34.1's L0 ("Organize"), L1 ("Personal local action": reversible, internal, always
 * logged/undoable), or — as of `prepare_cancellation` — L2, this codebase's name for spec AUTO-003's
 * "prepared actions" posture ("for consequential actions, gather everything and stop before final
 * submit"). L2 here is still zero external writes and zero money movement/messages sent on a real
 * account — it only STAGES the real, merchant-specific steps `merchant-cancellation-steps.ts` already
 * curates (see `preparedActions` in packages/db/src/schema/automation.ts) behind an explicit one-tap
 * user confirmation once they've actually gone and cancelled it themselves. Actually consequential
 * communication/commerce (spec's own L3/L4: send a message, place an order, move money) genuinely needs
 * "separate product controls, recent strong authentication" the spec calls out as its own scope — still
 * not something to bolt on as one more enum value here.
 */
export const TriggerKindSchema = z.enum([
  "new_bill",
  "new_purchase",
  "new_subscription",
  "new_shipment",
  "new_store_credit",
  "new_warranty",
  "new_appointment",
]);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const TriggerDescriptorSchema = z.object({
  kind: TriggerKindSchema,
  /** Case-insensitive substring match against the merchant/biller name, when the trigger's category has one. */
  merchantContains: z.string().nullable(),
  minAmountMinorUnits: z.number().int().nullable(),
  maxAmountMinorUnits: z.number().int().nullable(),
});
export type TriggerDescriptor = z.infer<typeof TriggerDescriptorSchema>;

export const ActionKindSchema = z.enum(["notify", "add_task", "add_calendar_event", "prepare_cancellation"]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/** Exactly one action per rule, always — `ActionDescriptorSchema` is a single object, never an array, and
 * every call site (`AutomationService.createRuleFromText`'s AI prompt, `executeRun`) assumes exactly one.
 * This is why spec §40.3's `partially_succeeded` automation-run state is currently unreachable: each action
 * kind here executes as one atomic operation, so a run can only ever fully succeed or fully fail — there's
 * no "some actions succeeded, others failed" outcome to represent yet. See `AutomationService`'s own
 * top-of-file doc comment for the full reasoning on why that's an honest gap to leave undriven rather than
 * building unreachable multi-action execution machinery nothing in this codebase can actually author. */
export const ActionDescriptorSchema = z.object({
  kind: ActionKindSchema,
  /** Custom notification body for "notify"; null uses a generated default. Capped defensively — an
   * adversarial or simply buggy AI response has no other bound before this reaches a real notification
   * row and gets displayed verbatim; nothing else in the notifications pipeline enforces a length limit
   * of its own, so this is the only backstop between AI output and a stored/displayed string. */
  message: z.string().max(500).nullable(),
  /** Task title for "add_task"; null uses a generated default. Capped to match every other task title
   * in the app (schedule/dto.ts's CreateTaskDtoSchema uses the same 300-character bound). */
  taskTitle: z.string().max(300).nullable(),
  /** Event title for "add_calendar_event"; null uses a generated default. Same 300-char bound as task
   * titles — same "AI output reaching a stored/displayed string needs a backstop" reasoning. */
  eventTitle: z.string().max(300).nullable(),
  /** How many days after the triggering event to place the calendar event's start, for "add_calendar_event"
   * only. This is a deliberately local-only action (per product decision: automation stays Veynlo-internal,
   * no new OAuth/connector write scopes) — `AutomationTriggerEvent` carries no due-date of its own (the
   * underlying bill/appointment/etc. dates live on their own domain rows, not in the trigger payload), so
   * "N days from when this rule fires" is the only offset the automation layer can compute itself. Clamped
   * 0-90 so a bad AI response can't schedule something absurdly far out. Null defaults to 0 (today). */
  daysFromNow: z.number().int().min(0).max(90).nullable(),
  /** Title for the staged `preparedActions` row created by "prepare_cancellation"; null uses the rule's
   * own name, same `?? rule.name` default every other action kind falls back to. Same 300-char bound and
   * "AI output needs a backstop before reaching a stored/displayed string" reasoning as taskTitle/eventTitle. */
  prepareCancellationTitle: z.string().max(300).nullable(),
});
export type ActionDescriptor = z.infer<typeof ActionDescriptorSchema>;

/** Deterministic, not AI-judged — §34.1's risk tiers are a fixed product decision per action kind, not
 * something worth trusting a model's guess on. "prepare_cancellation" is L2 (this codebase's name for spec
 * AUTO-003's "prepared actions" posture) — see this file's own top-of-file doc comment for why staging real
 * merchant steps behind an explicit confirmation is still a step above L1's "personal local action". */
export function riskTierForAction(kind: ActionKind): "L0" | "L1" | "L2" {
  if (kind === "notify") return "L0";
  if (kind === "prepare_cancellation") return "L2";
  return "L1";
}

export const RuleParseResultSchema = z.object({
  trigger: TriggerDescriptorSchema,
  action: ActionDescriptorSchema,
  /** Plain-English restatement of the rule — spec §34 AUTO-001: "Before activation, show trigger,
   * conditions, action, scope, exceptions and examples in plain English." Shown to the user to confirm
   * before the rule is ever enabled. */
  summary: z.string(),
});
export type RuleParseResult = z.infer<typeof RuleParseResultSchema>;

export const TRIGGER_KIND_BY_CATEGORY: Partial<Record<string, TriggerKind>> = {
  bill: "new_bill",
  purchase: "new_purchase",
  subscription: "new_subscription",
  shipment: "new_shipment",
  store_credit: "new_store_credit",
  warranty: "new_warranty",
  appointment: "new_appointment",
};
