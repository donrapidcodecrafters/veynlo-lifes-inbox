import { z } from "zod";
import { NormalizedEmailSchema } from "../../common/normalized-email";

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001 "direct object sharing") — grant a specific other
 * Veynlo account view access to one resource (a document, list, purchase, property, or vehicle today —
 * see SharingService's own doc comment), independent of household membership. Shared across every
 * resource-type controller that exposes grants/share-links, rather than one copy per module, since the
 * shape is identical regardless of what's being shared.
 */
// SHARE-001 "Set view/edit/manage" — view = read-only (the only right that ever did anything until this
// pass); edit = can modify the resource's own fields/items but not delete it or re-share it; manage = edit
// + delete the resource + create/revoke OTHER grants on it, but never transfer ownership. Ranked in this
// order (index = strength) so callers can compare "is this grant strong enough" with a single lookup —
// see SharingService.RIGHT_RANK.
export const ResourceGrantRightSchema = z.enum(["view", "edit", "manage"]);
export type ResourceGrantRight = z.infer<typeof ResourceGrantRightSchema>;

export const CreateResourceGrantDtoSchema = z.object({
  granteeEmail: NormalizedEmailSchema,
  // Defaults to "view" — unchanged prior behavior for any caller that doesn't send this yet (older mobile
  // builds, etc).
  right: ResourceGrantRightSchema.default("view"),
  // SHARE-001 "expiration" — optional; omitted means "until revoked" (unchanged prior behavior). The
  // enforcement side of this already existed and was already exercised (SharingService.hasActiveGrant/
  // grantedResourceIds have always filtered on `resourceGrants.expiresAt` — see their own `or(isNull(...),
  // gt(...))` checks) — this column was simply never *set* by any caller, so every direct grant was
  // effectively permanent regardless of what the spec's "Set view/edit/manage, expiration and optional
  // message" calls for. Capped the same as CreateShareLinkDtoSchema's own expiresInDays.
  expiresInDays: z.number().int().positive().max(365).optional(),
  // SHARE-001 "optional message" — a short free-text note shown to the recipient on the shared resource's
  // detail page ("Note from <granter>: ..."). Capped well under the notification-body-length range this
  // codebase already uses elsewhere for user-authored short text.
  message: z.string().trim().max(500).optional(),
});
export type CreateResourceGrantDto = z.infer<typeof CreateResourceGrantDtoSchema>;

/** Phase 2 §52.2 "object sharing" (spec SHARE-002 "secure external link") — a passcode is optional
 * (some content is fine to link without one); when set, it must meet a minimum length since it's the
 * only thing standing between the link and the resource once the token itself is known. */
export const CreateShareLinkDtoSchema = z.object({
  passcode: z.string().min(4).max(100).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});
export type CreateShareLinkDto = z.infer<typeof CreateShareLinkDtoSchema>;

export const AccessShareLinkDtoSchema = z.object({
  passcode: z.string().max(100).optional(),
});
export type AccessShareLinkDto = z.infer<typeof AccessShareLinkDtoSchema>;
