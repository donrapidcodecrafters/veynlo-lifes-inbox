import { z } from "zod";

/** Appendix C — Permission & Sensitivity Matrix. Drives default visibility, masking, and analytics granularity. */
export const SensitivityTierSchema = z.enum([
  "standard", // saved items, general notes, product metadata
  "sensitive", // email content, purchases, calendar titles, home/vehicle history, child logistics
  "highly_sensitive", // financial accounts, identity credentials, health logistics, precise location, smart-home presence
  "secret", // OAuth/session credentials — never in search/analytics/support planes
]);
export type SensitivityTier = z.infer<typeof SensitivityTierSchema>;

/** HH-002 — object-level privacy badge. Independent of household plan. */
export const VisibilitySchema = z.enum([
  "private", // visible only to the owning principal
  "household", // visible to all current household members
  "selected_people", // visible to an explicit grant list
  "shared_link", // visible via a scoped, revocable link
]);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const AccessRightSchema = z.enum(["view", "edit", "manage"]);
export type AccessRight = z.infer<typeof AccessRightSchema>;

export const ResourceGrantSchema = z.object({
  id: z.string(),
  resourceType: z.string(),
  resourceId: z.string(),
  granteeUserId: z.string(),
  right: AccessRightSchema,
  expiresAt: z.string().datetime().nullable(),
  grantedByUserId: z.string(),
  grantedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type ResourceGrant = z.infer<typeof ResourceGrantSchema>;

/**
 * Default visibility per sensitivity tier when an object is first created.
 * Users may widen (never the reverse silently) — spec: "private by default,
 * household sharing must not mean everything is automatically visible."
 */
export const DEFAULT_VISIBILITY_BY_SENSITIVITY: Record<SensitivityTier, Visibility> = {
  standard: "private",
  sensitive: "private",
  highly_sensitive: "private",
  secret: "private",
};

/** Highly sensitive categories can disallow public share links entirely. */
export function canCreateShareLink(tier: SensitivityTier): boolean {
  return tier === "standard" || tier === "sensitive";
}
