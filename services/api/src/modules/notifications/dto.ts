import { z } from "zod";

export const AcknowledgeNotificationDtoSchema = z.object({
  action: z.enum(["opened", "resolved", "dismissed", "snoozed"]),
});
export type AcknowledgeNotificationDto = z.infer<typeof AcknowledgeNotificationDtoSchema>;
