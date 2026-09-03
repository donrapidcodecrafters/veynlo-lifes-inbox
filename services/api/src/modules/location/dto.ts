import { z } from "zod";

export const CreatePlaceDtoSchema = z
  .object({
    label: z.string().min(1).max(120),
    address: z.string().max(500).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    householdId: z.string().nullable().optional(),
  })
  .refine((dto) => (dto.lat == null) === (dto.lng == null), { message: "lat and lng must both be set or both omitted." });
export type CreatePlaceDto = z.infer<typeof CreatePlaceDtoSchema>;

export const UpdatePlaceDtoSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    address: z.string().max(500).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
  })
  .refine((dto) => (dto.lat === undefined) === (dto.lng === undefined), {
    message: "lat and lng must be set or cleared together.",
  });
export type UpdatePlaceDto = z.infer<typeof UpdatePlaceDtoSchema>;

// LOC-005 — extraction only, does not save anything. The caller reviews the candidate (pre-filling a
// "create place" form) before deciding to save it.
export const ExtractPlaceCandidateDtoSchema = z.object({ text: z.string().min(1).max(5000) });
export type ExtractPlaceCandidateDto = z.infer<typeof ExtractPlaceCandidateDtoSchema>;

export const CreateGeofenceDtoSchema = z.object({
  placeId: z.string().min(1),
  radiusMeters: z.number().int().min(20).max(50_000).default(150),
  triggerKind: z.enum(["arrival", "departure", "both"]).default("arrival"),
});
export type CreateGeofenceDto = z.infer<typeof CreateGeofenceDtoSchema>;

export const UpdateGeofenceDtoSchema = z.object({
  radiusMeters: z.number().int().min(20).max(50_000).optional(),
  triggerKind: z.enum(["arrival", "departure", "both"]).optional(),
  isActive: z.boolean().optional(),
  // Set by the mobile app once it has actually registered the OS-native geofence region for this row.
  nativeIdentifier: z.string().max(200).nullable().optional(),
});
export type UpdateGeofenceDto = z.infer<typeof UpdateGeofenceDtoSchema>;

export const CreateContextRuleDtoSchema = z.object({
  geofenceId: z.string().min(1),
  actionKind: z.enum(["remind", "resurface_saved_item"]).default("remind"),
  actionTitle: z.string().min(1).max(300),
  actionPayload: z.record(z.string(), z.unknown()).optional(),
});
export type CreateContextRuleDto = z.infer<typeof CreateContextRuleDtoSchema>;

export const UpdateContextRuleDtoSchema = z.object({
  actionTitle: z.string().min(1).max(300).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateContextRuleDto = z.infer<typeof UpdateContextRuleDtoSchema>;

// Reported by the device once the OS actually fires a registered geofence region — never a raw
// coordinate, only which geofence and which direction. See LocationService's doc comment (LOC-006).
export const RecordGeofenceEventDtoSchema = z.object({
  geofenceId: z.string().min(1),
  triggerKind: z.enum(["arrival", "departure"]),
});
export type RecordGeofenceEventDto = z.infer<typeof RecordGeofenceEventDtoSchema>;

export const UpsertLocationPermissionStateDtoSchema = z.object({
  foregroundStatus: z.enum(["granted", "denied", "undetermined"]),
  backgroundStatus: z.enum(["granted", "denied", "undetermined"]),
  precision: z.enum(["precise", "approximate", "unknown"]),
});
export type UpsertLocationPermissionStateDto = z.infer<typeof UpsertLocationPermissionStateDtoSchema>;

export const EstimateTravelTimeDtoSchema = z.object({
  originPlaceId: z.string().min(1),
  destinationPlaceId: z.string().min(1),
});
export type EstimateTravelTimeDto = z.infer<typeof EstimateTravelTimeDtoSchema>;
