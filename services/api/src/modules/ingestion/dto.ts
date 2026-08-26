import { z } from "zod";

export const IngestManualDtoSchema = z.object({
  subject: z.string().min(1).max(500),
  bodyText: z.string().min(1).max(50_000),
  fromAddress: z.string().email().optional(),
});
export type IngestManualDto = z.infer<typeof IngestManualDtoSchema>;
