import { z } from "zod";
import { MoneySchema } from "../util/money";
import { TemporalValueSchema } from "../util/time";
import { ProvenanceSchema } from "./provenance";

/** §8 — Inbox: temporary review space before candidates become canonical facts. */
export const InboxItemReviewStateSchema = z.enum([
  "new",
  "reviewing",
  "confirmed",
  "corrected",
  "snoozed",
  "archived",
  "deleted",
]);
export type InboxItemReviewState = z.infer<typeof InboxItemReviewStateSchema>;

export const InboxItemSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  category: z.string(), // e.g. "purchase", "bill", "appointment", "warranty"
  summary: z.string(), // plain-language "concise extracted meaning"
  linkedResourceType: z.string().nullable(),
  linkedResourceId: z.string().nullable(),
  sourceEventId: z.string(),
  suggestedActions: z.array(z.string()).default([]),
  autoFiled: z.boolean().default(false),
  reviewState: InboxItemReviewStateSchema,
  snoozedUntil: z.string().datetime().nullable(),
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

/** §7 — Home "Needs You" priority queue. */
export const AttentionUrgencySchema = z.enum(["critical", "important", "useful", "informational"]);
export type AttentionUrgency = z.infer<typeof AttentionUrgencySchema>;

export const AttentionItemSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  reasonCode: z.string(), // e.g. "return_window_closing", "bill_due", "credential_expiring"
  reasonText: z.string(), // "We remind you because..."
  urgency: AttentionUrgencySchema,
  dueAt: TemporalValueSchema.nullable(),
  moneyAtStake: MoneySchema.nullable(),
  confidenceBand: z.string(),
  linkedResourceType: z.string().nullable(),
  linkedResourceId: z.string().nullable(),
  primaryActions: z.array(z.string()).default([]),
  resolved: z.boolean().default(false),
  dismissedReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

/** §33 — notification priority tiers; Critical cannot be created by low-confidence inference alone. */
export const NotificationPrioritySchema = z.enum(["critical", "important", "useful", "fyi", "silent"]);
export type NotificationPriority = z.infer<typeof NotificationPrioritySchema>;

export const NotificationChannelSchema = z.enum(["push", "email", "desktop", "in_app"]);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationStateSchema = z.enum(["queued", "sent", "suppressed", "opened", "actioned", "failed"]);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  dedupeKey: z.string(),
  priority: NotificationPrioritySchema,
  channel: NotificationChannelSchema,
  title: z.string(),
  body: z.string(),
  linkedAttentionItemId: z.string().nullable(),
  state: NotificationStateSchema,
  suppressionReason: z.string().nullable(),
  scheduledFor: z.string().datetime(),
  sentAt: z.string().datetime().nullable(),
  openedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationPreferenceSchema = z.object({
  userId: z.string(),
  intensity: z.enum(["quiet", "balanced", "proactive"]).default("balanced"),
  quietHoursStart: z.string().nullable(), // "22:00"
  quietHoursEnd: z.string().nullable(), // "07:00"
  categoryOverrides: z.record(z.string(), z.enum(["off", "digest_only", "push"])).default({}),
  dailyBriefEnabled: z.boolean().default(true),
  weeklyBriefEnabled: z.boolean().default(true),
});
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;
