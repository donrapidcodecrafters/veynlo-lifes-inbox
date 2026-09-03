import { z } from "zod";

/**
 * §14 "Contacts, People & Relationships" (PEO-001..005). `relationshipLabel` stays free text — see
 * `PERSON_RELATIONSHIP_SUGGESTIONS` (packages/db/src/schema/people.ts) for the suggested-not-enforced
 * vocabulary the UI offers as quick picks. `visibility` defaults to "private" server-side
 * (PeopleService.create) regardless of what's sent here — see people.ts's own schema doc comment on why a
 * personal contact must never default to household-visible.
 *
 * `source` defaults to "manual" (a person typed in directly) — the mobile device-contacts one-time import
 * flow (`expo-contacts`, PEO-001's "Apple Contacts/local address book" path, which has no server-side
 * connector the way Google/Microsoft Contacts do) passes `source: "apple_local"` instead, so the resulting
 * `contactSources` row correctly records where this person actually came from rather than always claiming
 * "manual" for evidence that was, in fact, a real device address-book entry.
 */
export const CreatePersonDtoSchema = z.object({
  displayName: z.string().min(1).max(200),
  organizationId: z.string().nullable().optional(),
  relationshipLabel: z.string().max(60).nullable().optional(),
  isImportant: z.boolean().optional(),
  householdId: z.string().nullable().optional(),
  emails: z.array(z.string().max(200)).max(20).optional(),
  phones: z.array(z.string().max(60)).max(20).optional(),
  source: z.enum(["manual", "apple_local"]).optional(),
});
export type CreatePersonDto = z.infer<typeof CreatePersonDtoSchema>;

export const UpdatePersonDtoSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  organizationId: z.string().nullable().optional(),
  isImportant: z.boolean().optional(),
});
export type UpdatePersonDto = z.infer<typeof UpdatePersonDtoSchema>;

/** PEO-003 "labels are user-editable" — the confirm/edit path. Always sets `relationshipLabelSource:
 * "user_set"`, whether this is a first-time label, an edit of a prior user-set one, or the user confirming
 * a "suggested" one (see PeopleService.confirmSuggestedRelationshipLabel for the narrower confirm-only
 * action that doesn't require retyping the label). */
export const SetRelationshipLabelDtoSchema = z.object({
  relationshipLabel: z.string().min(1).max(60),
});
export type SetRelationshipLabelDto = z.infer<typeof SetRelationshipLabelDtoSchema>;

/** PEO-001 "share contact" visibility toggle — mirrors HealthLogisticsService.setAppointmentVisibility's
 * shape (owner-only, requires a household before "household" is a legal value). */
export const SetPersonVisibilityDtoSchema = z.object({
  visibility: z.enum(["private", "household"]),
});
export type SetPersonVisibilityDto = z.infer<typeof SetPersonVisibilityDtoSchema>;

export const AddAliasDtoSchema = z.object({
  kind: z.enum(["email", "phone", "name_variant"]),
  value: z.string().min(1).max(200),
});
export type AddAliasDto = z.infer<typeof AddAliasDtoSchema>;

export const AddPersonNoteDtoSchema = z.object({
  body: z.string().min(1).max(5000),
});
export type AddPersonNoteDto = z.infer<typeof AddPersonNoteDtoSchema>;

/**
 * PEO-005 "important dates" — `isSensitive` defaults false; a caller marks true for a category (e.g. a
 * private provider's or an ex-partner's birthday) that must stay owner-only even if the parent Person row
 * itself is shared household-wide (see personImportantDates' own schema doc comment).
 */
export const AddImportantDateDtoSchema = z.object({
  label: z.string().min(1).max(80),
  dateIso: z.string().min(1),
  isSensitive: z.boolean().optional(),
  reminderDaysBefore: z.number().int().min(0).max(90).optional(),
});
export type AddImportantDateDto = z.infer<typeof AddImportantDateDtoSchema>;

/** PEO-003/PEO-004 user-declared relationship edge — exactly one of `toPersonId`/`toDependentProfileId`
 * required, enforced in PeopleService.addRelationship. */
export const AddPersonRelationshipDtoSchema = z
  .object({
    toPersonId: z.string().nullable().optional(),
    toDependentProfileId: z.string().nullable().optional(),
    label: z.string().min(1).max(80),
  })
  .refine((v) => Boolean(v.toPersonId) !== Boolean(v.toDependentProfileId), {
    message: "Provide exactly one of toPersonId or toDependentProfileId.",
  });
export type AddPersonRelationshipDto = z.infer<typeof AddPersonRelationshipDtoSchema>;

export const CreateOrganizationDtoSchema = z.object({
  name: z.string().min(1).max(200),
  organizationType: z.string().max(60).nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreateOrganizationDto = z.infer<typeof CreateOrganizationDtoSchema>;

/** PEO-004 generic linking mechanism — see people.relatedEntityIds' own schema doc comment. */
export const LinkRelatedEntityDtoSchema = z.object({
  entityId: z.string().min(1),
});
export type LinkRelatedEntityDto = z.infer<typeof LinkRelatedEntityDtoSchema>;

/** PEO-002 "ambiguous merges require review" — the user picks which of two candidate people survives. */
export const MergePeopleDtoSchema = z.object({
  survivingPersonId: z.string().min(1),
  mergedPersonId: z.string().min(1),
});
export type MergePeopleDto = z.infer<typeof MergePeopleDtoSchema>;
