import { z } from "zod";

/**
 * FIN-001's per-account inclusion toggle. It previously took @Body("isIncluded") with no pipe and then
 * called Boolean(isIncluded) - which does not reject a non-boolean, it reinterprets one, so the string
 * "false" switched the account ON.
 */
export const SetAccountIncludedDtoSchema = z.object({ isIncluded: z.boolean() });
export type SetAccountIncludedDto = z.infer<typeof SetAccountIncludedDtoSchema>;
