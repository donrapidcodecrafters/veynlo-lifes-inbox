import { z } from "zod";

/**
 * §27 "Health Logistics (Non-Diagnostic)" (HLTH-001) manual-add — mirrors CreateEventDtoSchema's shape
 * (schedule/dto.ts) for the same reason: previously every health appointment could only arrive via AI
 * discovery, never a direct user add. `prepInstructions` here is user-typed directly (not AI-derived), so
 * the "only when literally sourced" constraint that governs the AI extraction path
 * (HealthAppointmentExtractionSchema) doesn't apply — a user is always free to write their own note.
 */
export const CreateHealthAppointmentDtoSchema = z.object({
  providerName: z.string().max(200).nullable().optional(),
  appointmentType: z.string().max(120).nullable().optional(),
  startIso: z.string().min(1),
  location: z.string().max(300).nullable().optional(),
  prepInstructions: z.string().max(2000).nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreateHealthAppointmentDto = z.infer<typeof CreateHealthAppointmentDtoSchema>;

/**
 * HLTH-003 "medication refill reminder" — deliberately thin, matching `refillReminders`' own schema
 * ("nothing to compute, just a date to remind about"): a plain user-entered medication label, a next
 * refill/pickup date, and an optional pharmacy name. No dose/frequency/clinical field exists to submit.
 */
export const CreateRefillReminderDtoSchema = z.object({
  medicationName: z.string().min(1).max(200),
  nextRefillIso: z.string().min(1),
  pharmacy: z.string().max(200).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  dependentProfileId: z.string().nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreateRefillReminderDto = z.infer<typeof CreateRefillReminderDtoSchema>;

/** HLTH-004 "medical bill/EOB organizer" — links an existing bill to an existing health appointment. */
export const LinkBillToAppointmentDtoSchema = z.object({
  healthAppointmentId: z.string().min(1),
});
export type LinkBillToAppointmentDto = z.infer<typeof LinkBillToAppointmentDtoSchema>;

/** HLTH-001 "forms/tasks" linkage — links an existing task the caller owns to a health appointment they
 * own, mirroring LinkBillToAppointmentDtoSchema exactly (see HealthLogisticsService.linkTaskToAppointment). */
export const LinkTaskToAppointmentDtoSchema = z.object({
  healthAppointmentId: z.string().min(1),
});
export type LinkTaskToAppointmentDto = z.infer<typeof LinkTaskToAppointmentDtoSchema>;

/** HLTH-001/002 "attach an insurance-card/EOB document" — links an existing HEALTH_DOCUMENT_TYPES document
 * the caller owns to a health appointment they own (see HealthLogisticsService.linkDocumentToAppointment). */
export const LinkDocumentToAppointmentDtoSchema = z.object({
  healthAppointmentId: z.string().min(1),
});
export type LinkDocumentToAppointmentDto = z.infer<typeof LinkDocumentToAppointmentDtoSchema>;

/** HLTH-002 step-up gate for opening a health-tagged document — mirrors EmergencyBinderService's own
 * `getBinder(password)` shape, which reuses IdentityService.verifyStepUpPassword the same way. */
export const OpenHealthDocumentDtoSchema = z.object({
  password: z.string().optional(),
});
export type OpenHealthDocumentDto = z.infer<typeof OpenHealthDocumentDtoSchema>;

/** HLTH-001 "export selected packet" — same §28.9 step-up shape as RequestExportDtoSchema
 * (data-export/dto.ts), scoped optionally to a single appointment (see
 * HealthLogisticsService.exportHealthPacket). Omitting `appointmentId` exports every appointment/refill
 * reminder/linked bill the caller owns; providing one scopes the packet to just that appointment. */
export const ExportHealthPacketDtoSchema = z.object({
  password: z.string().optional(),
  appointmentId: z.string().nullable().optional(),
});
export type ExportHealthPacketDto = z.infer<typeof ExportHealthPacketDtoSchema>;
