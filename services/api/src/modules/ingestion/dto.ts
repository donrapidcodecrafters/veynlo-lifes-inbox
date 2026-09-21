import { z } from "zod";

export const IngestManualDtoSchema = z.object({
  subject: z.string().min(1).max(500),
  bodyText: z.string().min(1).max(50_000),
  fromAddress: z.string().email().optional(),
  // §MSG-001 — lets the OS share-sheet capture path (iOS Share Extension, Android share intent) identify
  // itself distinctly from text typed directly into the app. Deliberately a one-value enum rather than the
  // full SourceEventKindSchema: the client must not be able to spoof internal-only kinds like
  // "email_message" or "financial_transaction" by passing an arbitrary kind through this DTO.
  kind: z.enum(["share_capture"]).optional(),
});
export type IngestManualDto = z.infer<typeof IngestManualDtoSchema>;

export const IngestUrlDtoSchema = z.object({
  url: z.string().url().max(2000),
  /**
   * Whatever the user shared ALONGSIDE the link.
   *
   * A share sheet rarely hands over a bare URL. TikTok's carries a caption; a person forwarding a
   * restaurant adds "for Saturday?". That text is the reason they saved it and is frequently the only part
   * that says why, so it is kept with the page rather than discarded to make the URL fit this endpoint.
   */
  note: z.string().trim().max(4000).optional(),
  /**
   * Marks an OS share-sheet capture, exactly as `IngestManualDtoSchema.kind` does — the mobile share path
   * sends a URL here now rather than to /manual, and losing that distinction would make a deliberate share
   * indistinguishable from a link typed into the app.
   */
  kind: z.enum(["share_capture"]).optional(),
});
export type IngestUrlDto = z.infer<typeof IngestUrlDtoSchema>;

/** A single EventKit/local-calendar event pushed from the mobile app — see IngestionService.ingestFeedCalendarEvent, the same "already a calendar event, no AI needed" write path the ICS/Google/Microsoft calendar connectors share. */
export const DeviceCalendarEventDtoSchema = z.object({
  uid: z.string().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  startIso: z.string().min(1),
  endIso: z.string().nullable(),
  isAllDay: z.boolean(),
  location: z.string().max(500).nullable(),
});

export const IngestDeviceCalendarDtoSchema = z.object({
  events: z.array(DeviceCalendarEventDtoSchema).max(500),
});
export type IngestDeviceCalendarDto = z.infer<typeof IngestDeviceCalendarDtoSchema>;

/** A single EventKit reminder (Apple Reminders, iOS only — Android has no equivalent OS framework) pushed
 * from the mobile app. See IngestionService.ingestDeviceReminder. */
export const DeviceReminderDtoSchema = z.object({
  uid: z.string().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  dueIso: z.string().nullable(),
  notes: z.string().max(2000).nullable(),
  completed: z.boolean(),
});

export const IngestDeviceRemindersDtoSchema = z.object({
  reminders: z.array(DeviceReminderDtoSchema).max(500),
});
export type IngestDeviceRemindersDto = z.infer<typeof IngestDeviceRemindersDtoSchema>;

/** Postmark's inbound-parse webhook shape (https://postmarkapp.com/developer/webhooks/inbound-webhook) —
 * only the fields this pipeline actually uses; a real deployment behind a different provider (Mailgun/
 * SendGrid) would map that provider's payload onto this same shape at the controller boundary. */
export const InboundEmailWebhookDtoSchema = z.object({
  To: z.string().min(1).max(500),
  From: z.string().min(1).max(500),
  Subject: z.string().max(500).default(""),
  TextBody: z.string().max(50_000).default(""),
});
export type InboundEmailWebhookDto = z.infer<typeof InboundEmailWebhookDtoSchema>;
