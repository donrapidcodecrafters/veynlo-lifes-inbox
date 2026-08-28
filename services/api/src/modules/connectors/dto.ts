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
