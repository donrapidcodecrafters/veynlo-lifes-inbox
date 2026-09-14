import { z } from "zod";

// PRIV-002 "category selection" — the recognized top-level manifest domains a user can choose to export
// selectively; kept in sync by hand with DataExportService.buildManifest's own section keys. Any string
// not in this list is rejected by the schema below rather than silently ignored, so a typo/renamed
// category in the client never produces a manifest that quietly excludes more than the user asked for.
export const EXPORT_CATEGORIES = [
  "purchases",
  "bills",
  "warranties",
  "subscriptions",
  "calendarEvents",
  "tasks",
  "documents",
  "inboxItems",
  "notifications",
  // Everything below was missing. The nine above are what "export everything" used to mean, which left
  // most of the Life tab — Home, Vehicles, Pets, People, Places, Trips, Lists, Saved, Identity, Finance —
  // out of a file the user was told contained all their data. See DataExportService.buildManifest.
  "lists",
  "savedItems",
  "people",
  "pets",
  "home",
  "vehicles",
  "places",
  "trips",
  "identityRecords",
  "finance",
  "storeCredits",
  "school",
  "healthAppointments",
  "automations",
  "attentionItems",
  "notes",
  "senderRules",
  "entities",
  "connections",
] as const;
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number];

// §28.9 step-up auth — password is optional in the schema because it's only actually required for an
// account that has one (see IdentityService.verifyStepUpPassword's doc comment on why OAuth-only accounts
// skip this check entirely rather than being permanently locked out of exporting their own data).
export const RequestExportDtoSchema = z.object({
  password: z.string().optional(),
  // Omitted/undefined means "export everything" — the only behavior that existed before this field did,
  // preserved exactly for every caller that doesn't pass it.
  selectedCategories: z.array(z.enum(EXPORT_CATEGORIES)).min(1).optional(),
});
export type RequestExportDto = z.infer<typeof RequestExportDtoSchema>;
