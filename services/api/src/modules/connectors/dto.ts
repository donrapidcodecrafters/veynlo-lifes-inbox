import { z } from "zod";

/**
 * ICS is a calendar-feed-by-URL subscription, not an OAuth-shaped connector — most feeds are either fully
 * public or embed a secret directly in the URL itself (e.g. Google Calendar's private ICS links); some
 * corporate calendar systems put the feed behind HTTP Basic Auth instead, hence the optional pair.
 */
export const IcsConnectDtoSchema = z.object({
  url: z.string().url(),
  feedName: z.string().min(1).max(120).optional(),
  basicAuthUsername: z.string().max(200).optional(),
  basicAuthPassword: z.string().max(200).optional(),
});
export type IcsConnectDto = z.infer<typeof IcsConnectDtoSchema>;

export const PlaidExchangeDtoSchema = z.object({
  publicToken: z.string().min(1),
  // ONB-002 — optional historical-depth choice from the onboarding flow (or a future Connections-page
  // depth picker); EntitlementsService.resolveHistoricalBackfillDays clamps it to the caller's plan.
  historyDepthDays: z.number().int().min(0).max(3650).optional(),
});
export type PlaidExchangeDto = z.infer<typeof PlaidExchangeDtoSchema>;

/**
 * Five connector endpoints took a single field via @Body("...") and so never reached a pipe. The three
 * booleans were coerced with Boolean(...) at the call site, which does not reject a wrong type so much as
 * reinterpret it - Boolean("false") is true, so {"enabled":"false"} turned write-back ON.
 */
export const SetWriteBackDtoSchema = z.object({ enabled: z.boolean() });
export type SetWriteBackDto = z.infer<typeof SetWriteBackDtoSchema>;

export const DisconnectConnectionDtoSchema = z.object({
  deleteDerivedData: z.boolean().optional(),
  password: z.string().min(1).optional(),
});
export type DisconnectConnectionDto = z.infer<typeof DisconnectConnectionDtoSchema>;

/** Null is meaningful here: it clears the per-connection override and falls back to the global setting. */
export const SetAiProcessingDtoSchema = z.object({ enabled: z.boolean().nullable() });
export type SetAiProcessingDto = z.infer<typeof SetAiProcessingDtoSchema>;

export const SetPausedDtoSchema = z.object({ paused: z.boolean() });
export type SetPausedDto = z.infer<typeof SetPausedDtoSchema>;

export const AddExclusionDtoSchema = z.object({ excludedSenderDomain: z.string().min(1).max(255) });
export type AddExclusionDto = z.infer<typeof AddExclusionDtoSchema>;

export const PushCalendarEventDtoSchema = z.object({ connectionId: z.string().min(1) });
export type PushCalendarEventDto = z.infer<typeof PushCalendarEventDtoSchema>;
