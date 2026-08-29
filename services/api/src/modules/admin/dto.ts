import { z } from "zod";

export const CreateAdminDtoSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  role: z.enum(["support", "superadmin"]).default("support"),
});
export type CreateAdminDto = z.infer<typeof CreateAdminDtoSchema>;

export const GrantEntitlementDtoSchema = z.object({
  planKey: z.enum(["free", "plus", "family", "pro_agent"]),
  reason: z.string().min(1).max(500),
  // null = indefinite (e.g. grandfathering); a number = a time-boxed comp (e.g. "one free month for a bug they hit").
  durationDays: z.number().int().positive().max(3653).nullable(),
});
export type GrantEntitlementDto = z.infer<typeof GrantEntitlementDtoSchema>;
