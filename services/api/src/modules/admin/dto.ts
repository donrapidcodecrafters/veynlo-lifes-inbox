import { z } from "zod";

export const CreateAdminDtoSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  role: z.enum(["support", "superadmin"]).default("support"),
});
export type CreateAdminDto = z.infer<typeof CreateAdminDtoSchema>;
