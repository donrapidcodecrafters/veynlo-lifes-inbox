import { z } from "zod";

/** Free text the user types onto a record's history. Bounded so one note cannot be unbounded input. */
export const AddHistoryNoteDtoSchema = z.object({ noteText: z.string().min(1).max(5000) });
export type AddHistoryNoteDto = z.infer<typeof AddHistoryNoteDtoSchema>;
