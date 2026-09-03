import { z } from "zod";

/**
 * One schema covering every domain "correct" can touch (purchase/bill/calendar_event/shipment) rather
 * than a per-type route — which fields actually apply is decided in InboxService.correct() once the
 * item's linkedResourceType is known, not before. All fields optional: a correction only sends what the
 * user actually changed. Merchant-name correction is deliberately out of scope for now — it would need
 * IngestionService's private findOrCreateMerchant lookup/creation logic, not just a column update.
 */
export const CorrectInboxItemDtoSchema = z.object({
  // purchase
  orderNumber: z.string().max(200).nullable().optional(),
  totalMinorUnits: z.number().int().optional(),
  totalCurrency: z.string().length(3).optional(),
  taxMinorUnits: z.number().int().nullable().optional(),
  shippingMinorUnits: z.number().int().nullable().optional(),
  purchaseDateIso: z.string().min(1).optional(),
  // bill
  billerLabel: z.string().min(1).max(200).optional(),
  amountDueMinorUnits: z.number().int().optional(),
  amountDueCurrency: z.string().length(3).optional(),
  dueDateIso: z.string().min(1).optional(),
  autopayBelieved: z.boolean().optional(),
  // calendar_event
  title: z.string().min(1).max(300).optional(),
  location: z.string().max(300).nullable().optional(),
  isAllDay: z.boolean().optional(),
  startIso: z.string().min(1).optional(),
  endIso: z.string().nullable().optional(),
  // shipment
  carrier: z.string().max(100).optional(),
  trackingNumber: z.string().max(200).optional(),
  status: z.string().max(50).optional(),
  estimatedDeliveryIso: z.string().nullable().optional(),
  // warranty
  productLabel: z.string().min(1).max(200).optional(),
  warrantyLengthMonths: z.number().int().nullable().optional(),
  expirationDateIso: z.string().min(1).optional(),
  registrationConfirmed: z.boolean().nullable().optional(),
  // subscription
  serviceLabel: z.string().min(1).max(200).optional(),
  cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "irregular"]).optional(),
  typicalAmountMinorUnits: z.number().int().nullable().optional(),
  typicalAmountCurrency: z.string().length(3).optional(),
  cancellationInstructionsUrl: z.string().max(500).nullable().optional(),
});
export type CorrectInboxItemDto = z.infer<typeof CorrectInboxItemDtoSchema>;

/** Phase 2 §52.2 "bulk management" (spec DSK-004, and §37.1's own "12 receipts found... one rule-level
 * question instead of 12 repetitive confirmations"). Capped well above any realistic single-page batch —
 * a bound against a client bug sending an unbounded array, not a real usage limit. */
export const BulkInboxActionDtoSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
});
export type BulkInboxActionDto = z.infer<typeof BulkInboxActionDtoSchema>;

/**
 * CAL-002 "Add to calendar with chosen destination and reminder defaults" — `destinationConnectionId: null`
 * (the default) means "keep in Life Inbox only," matching how this app actually models "calendars" today:
 * there's no multi-calendar-per-user concept beyond the single `calendar_events` table, so the real choice
 * is Life Inbox vs. a specific connected, write-back-enabled provider connection (see
 * InboxService.addToCalendar). `reminderMinutesBefore` is capped at 3 days — a lead time longer than that
 * isn't really a "reminder" for an appointment/reservation anymore, and the picker on both web and mobile
 * only ever offers options within this range.
 */
export const AddToCalendarDtoSchema = z.object({
  destinationConnectionId: z.string().nullable().optional(),
  reminderMinutesBefore: z.number().int().min(0).max(4320).optional(),
});
export type AddToCalendarDto = z.infer<typeof AddToCalendarDtoSchema>;

/** CAL-004 — the "apply_change" action on an offered reschedule (InboxService.applyRescheduleChange).
 * `trustSender` is the "Always trust reschedule emails like this one" checkbox reachable right from the
 * offered-change item itself — the natural place a user opts in, at the moment they see the first
 * legitimate reschedule from a given sender. */
export const ApplyRescheduleDtoSchema = z.object({
  trustSender: z.boolean().optional().default(false),
});
export type ApplyRescheduleDto = z.infer<typeof ApplyRescheduleDtoSchema>;

/** CAL-004 trusted-reschedule-rule settings surface — add a rule directly (not via an offered item).
 * Accepts a bare domain ("united.com") or a full address ("reschedule@united.com") — normalized server-side
 * by `normalizeSenderDomain`. */
export const AddTrustedRescheduleRuleDtoSchema = z.object({
  senderDomain: z.string().min(1).max(255),
});
export type AddTrustedRescheduleRuleDto = z.infer<typeof AddTrustedRescheduleRuleDtoSchema>;

/** CAL-003 "email-vs-calendar date disagreement" — the user's own choice between the two conflicting dates,
 * behind the `["use_email_date", "keep_calendar_date", "dismiss"]` suggestedActions on the item
 * `IngestionService.checkCalendarDateDisagreement` files (see InboxService.resolveDateDisagreement). Never
 * auto-picked — this dto only ever carries the user's explicit decision. */
export const ResolveDateDisagreementDtoSchema = z.object({
  choice: z.enum(["use_email_date", "keep_calendar_date"]),
});
export type ResolveDateDisagreementDto = z.infer<typeof ResolveDateDisagreementDtoSchema>;

/** MAIL-006 "User sender rules" — "Always treat messages from this sender as School / Bills / Ignore /
 * Keep only attachments / Household shared." Mirrors `packages/db/src/schema/sender-rules.ts`'s
 * `senderRuleActionEnum` exactly. */
export const SenderRuleActionSchema = z.enum(["always_school", "always_bills", "ignore", "attachments_only", "household_shared"]);
export type SenderRuleAction = z.infer<typeof SenderRuleActionSchema>;

/** MAIL-006 standalone settings-page add (web + mobile) — exactly one of senderDomain/senderEmail, matching
 * the table's own two independent unique indexes (see that schema file's doc comment on why). Accepts
 * either a bare domain/address or "Name <email>" — normalized server-side by InboxService.addSenderRule via
 * the same extractEmailAddress/normalizeSenderDomain helpers every other sender-scoped rule in this codebase
 * (CAL-004's trusted-reschedule rules, MAIL-006's own inline correction action below) already uses. */
export const AddSenderRuleDtoSchema = z
  .object({
    senderDomain: z.string().min(1).max(255).optional(),
    senderEmail: z.string().min(1).max(320).optional(),
    action: SenderRuleActionSchema,
  })
  .refine((d) => Boolean(d.senderDomain) !== Boolean(d.senderEmail), {
    message: "Provide exactly one of senderDomain or senderEmail.",
  });
export type AddSenderRuleDto = z.infer<typeof AddSenderRuleDtoSchema>;

/** MAIL-006 inline "Always treat mail from this sender as..." action, reachable right from an Inbox item's
 * own correction flow (see InboxService.addSenderRuleFromInboxItem) — the natural place a user would opt
 * in, at the moment they see a misclassified (or correctly classified but unwanted) item from a given
 * sender, mirroring CAL-004's identical "trust this sender" action reachable from an offered reschedule. */
export const AddSenderRuleFromInboxItemDtoSchema = z.object({
  action: SenderRuleActionSchema,
});
export type AddSenderRuleFromInboxItemDto = z.infer<typeof AddSenderRuleFromInboxItemDtoSchema>;
