import { z } from "zod";

/** SCH-002 manual school creation, mirroring AssetsService's manual property/vehicle add — see
 * CorrectSchoolDtoSchema below for SCH-001's actual "correct school" user action (re-pointing an already-
 * discovered event/form at a different school, not creating one). */
export const CreateSchoolDtoSchema = z.object({
  householdId: z.string().min(1),
  name: z.string().min(1).max(200),
  address: z.string().max(400).nullable().optional(),
});
export type CreateSchoolDto = z.infer<typeof CreateSchoolDtoSchema>;

/**
 * SCH-002 "subscribe/unsubscribe feed." `icsUrl` is required for kind "ics" and ignored for
 * "forwarding_email" (that kind has no URL — see school.ts schema's own doc comment on why forwarding is
 * just a UI affordance over the existing per-user inbound alias, not a second address/pipeline).
 */
export const CreateSchoolSourceDtoSchema = z
  .object({
    householdId: z.string().min(1),
    schoolId: z.string().nullable().optional(),
    label: z.string().min(1).max(200),
    kind: z.enum(["ics", "forwarding_email"]).default("ics"),
    icsUrl: z.string().url().max(2000).nullable().optional(),
  })
  .refine((v) => v.kind !== "ics" || Boolean(v.icsUrl), { message: "An ICS feed URL is required.", path: ["icsUrl"] });
export type CreateSchoolSourceDto = z.infer<typeof CreateSchoolSourceDtoSchema>;

/** SCH-001 "assign child" — dependentId: null explicitly clears a (possibly wrong) prior assignment. */
export const AssignChildDtoSchema = z.object({ dependentId: z.string().nullable() });
export type AssignChildDto = z.infer<typeof AssignChildDtoSchema>;

/** SCH-001 "correct school" — found live, missing entirely: named explicitly in the spec's own SCH-001
 * action list alongside "assign child" (AssignChildDtoSchema above), but nothing let a user fix a
 * misfiled `schoolId` on an already-discovered event/form. schoolId: null explicitly clears a wrong
 * assignment, same shape as AssignChildDtoSchema's dependentId. */
export const CorrectSchoolDtoSchema = z.object({ schoolId: z.string().nullable() });
export type CorrectSchoolDto = z.infer<typeof CorrectSchoolDtoSchema>;

export const PermissionFormStateSchema = z.enum(["discovered", "opened", "completed", "submitted", "confirmed"]);

/** SCH-006 "complete form task" — see SchoolService.advanceFormState's doc comment on the forward-only stance. */
export const AdvanceFormStateDtoSchema = z.object({ state: PermissionFormStateSchema });
export type AdvanceFormStateDto = z.infer<typeof AdvanceFormStateDtoSchema>;

/** Manual permission-form add — for a form the user knows about before any email ever mentions it (e.g. a paper form sent home). */
export const CreatePermissionFormDtoSchema = z.object({
  householdId: z.string().min(1),
  title: z.string().min(1).max(300),
  dependentId: z.string().nullable().optional(),
  schoolId: z.string().nullable().optional(),
  dueIso: z.string().nullable().optional(),
});
export type CreatePermissionFormDto = z.infer<typeof CreatePermissionFormDtoSchema>;
