import { z } from "zod";

export const IngestManualDtoSchema = z.object({
  subject: z.string().min(1).max(500),
  bodyText: z.string().min(1).max(50_000),
  fromAddress: z.string().email().optional(),
});
export type IngestManualDto = z.infer<typeof IngestManualDtoSchema>;

/** A single EventKit/local-calendar event pushed from the mobile app — see IngestionService.ingestFeedCalendarEvent, the same "already a calendar event, no AI needed" write path the ICS/Google/Microsoft calendar connectors share. */
export const DeviceCalendarEventDtoSchema = z.object({
  uid: z.string().min(1).max(500),
  title: z.string().min(1).max(500),
  startIso: z.string().min(1),
  endIso: z.string().nullable(),
  isAllDay: z.boolean(),
  location: z.string().max(500).nullable(),
});

export const IngestDeviceCalendarDtoSchema = z.object({
  events: z.array(DeviceCalendarEventDtoSchema).max(500),
});
export type IngestDeviceCalendarDto = z.infer<typeof IngestDeviceCalendarDtoSchema>;
