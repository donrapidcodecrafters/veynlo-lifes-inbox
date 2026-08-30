import { z } from "zod";

export const RequestExportDtoSchema = z.object({
  // Optional: an OAuth-only account (Google/Microsoft sign-in) has no password to confirm at all — its
  // already-verified session is the reauth for those accounts. See IdentityService.verifyPassword.
  password: z.string().min(1).max(200).optional(),
});
export type RequestExportDto = z.infer<typeof RequestExportDtoSchema>;
