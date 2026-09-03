import { z } from "zod";

/** §29.1 SAVE-001 "Accept page/link, screenshot, image, text, document, map/place, product, recipe,
 * event, video/page metadata, quote or freeform note." "screenshot"/"image"/"document" go through the
 * separate multipart POST /v1/memories/upload (which delegates to DocumentsService.upload for real binary
 * storage) — everything else is a plain JSON save. */
export const MEMORY_SOURCE_KINDS = ["link", "screenshot", "image", "text", "document", "place", "product", "recipe", "event", "video", "note"] as const;

export const MEMORY_CATEGORIES = [
  "product",
  "place",
  "recipe",
  "article",
  "movie_show",
  "gift_idea",
  "event",
  "trip_idea",
  "how_to",
  "reference",
  "document",
  "generic",
] as const;

// SAVE-006 "tags, ratings, highlights" shared field constraints — reused by both create and update DTOs.
const TagsSchema = z.array(z.string().min(1).max(60)).max(30);
const HighlightsSchema = z.array(z.string().min(1).max(2000)).max(50);
const RatingSchema = z.number().int().min(1).max(5);

export const CreateMemoryDtoSchema = z.object({
  sourceKind: z.enum(MEMORY_SOURCE_KINDS),
  sourceUrl: z.string().url().max(2000).optional(),
  rawText: z.string().max(20_000).optional(),
  title: z.string().max(300).optional(),
  userNotes: z.string().max(5000).optional(),
  tags: TagsSchema.optional(),
});
export type CreateMemoryDto = z.infer<typeof CreateMemoryDtoSchema>;

export const CreateMemoryFromUploadDtoSchema = z.object({
  sourceKind: z.enum(["screenshot", "image", "document"]),
  title: z.string().max(300).optional(),
  userNotes: z.string().max(5000).optional(),
});
export type CreateMemoryFromUploadDto = z.infer<typeof CreateMemoryFromUploadDtoSchema>;

/** SAVE-001 "edit category/title/notes... pin, archive... mark not useful"; SAVE-007 "never resurface
 * automatically... auto-archive after a condition." `category`/`categoryConfidence` are user-editable
 * post-hoc per SAVE-002 ("Category is editable and not required before save") — setting `category` here
 * always wins over whatever the classifier produced, and clears `categoryConfidence` to null (a
 * user-chosen category has no "confidence," it's a fact now). */
export const UpdateMemoryDtoSchema = z.object({
  title: z.string().max(300).optional(),
  userNotes: z.string().max(5000).nullable().optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  relatedPersonLabel: z.string().max(120).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  neverResurface: z.boolean().optional(),
  autoArchiveAtIso: z.string().datetime().nullable().optional(),
  markNotUseful: z.boolean().optional(),
  // SAVE-006 "tags, ratings, highlights" — each replaces the whole list/value wholesale (the client sends
  // the full desired array after an add/remove, same "whole-value PUT" shape `userNotes`/`category`
  // already use here; no separate add-one/remove-one endpoints since these are always small, owner-edited
  // lists rendered and edited in full on the detail page already).
  tags: TagsSchema.optional(),
  rating: RatingSchema.nullable().optional(),
  highlights: HighlightsSchema.optional(),
});
export type UpdateMemoryDto = z.infer<typeof UpdateMemoryDtoSchema>;

/** SAVE-001 "convert to task/event/object" — see saved_memories.promotedEntityType/Id's own schema doc
 * comment: the client creates the real Task/Event/etc. through that domain's own endpoint first, then
 * links it back here. `entityType` stays a free string (not an enum) — matching every other polymorphic
 * `linkedResourceType` column in this codebase — since the set of promotable domains isn't fixed here. */
export const PromoteMemoryDtoSchema = z.object({
  entityType: z.string().min(1).max(60),
  entityId: z.string().min(1).max(200),
});
export type PromoteMemoryDto = z.infer<typeof PromoteMemoryDtoSchema>;

/** SAVE-001 "request resurfacing rule." `date` needs an explicit date; `person_birthday` needs a household
 * dependent to key off; `trip_location` needs a place/destination label, matched against the owner's own
 * upcoming/active trips (packages/db/src/schema/travel.ts's `trips.destinationLabel`) at scan time — see
 * resurfacing.service.ts's evaluateTripLocationRule. `location_proximity` needs one of the owner's own
 * saved `places` rows (packages/db/src/schema/location.ts) — fires event-driven off a real geofence
 * arrival, not on the scan tick — see ResurfacingService.fireLocationProximityResurfacing and
 * LocationService.recordGeofenceEvent. */
export const CreateResurfacingRuleDtoSchema = z.union([
  z.object({ triggerType: z.literal("date"), dateIso: z.string().datetime() }),
  z.object({ triggerType: z.literal("person_birthday"), dependentProfileId: z.string().min(1), daysBefore: z.number().int().min(0).max(90).default(14) }),
  z.object({ triggerType: z.literal("trip_location"), locationLabel: z.string().min(1).max(200) }),
  z.object({ triggerType: z.literal("location_proximity"), placeId: z.string().min(1) }),
]);
export type CreateResurfacingRuleDto = z.infer<typeof CreateResurfacingRuleDtoSchema>;

/**
 * §29.1 SAVE-003 "Smart lists... rules such as 'all recipes,' 'gift ideas for Dad,' 'places in Denver,' or
 * 'products under $500.'" Every field is optional and AND'ed together by MemoriesService.evaluateSmartQuery
 * — an empty object matches every one of the owner's non-archived memories (a plain "everything I've
 * saved" smart list is a valid, if trivial, criteria set).
 */
export const SmartListQuerySchema = z.object({
  category: z.enum(MEMORY_CATEGORIES).optional(),
  personLabelContains: z.string().max(120).optional(),
  locationContains: z.string().max(120).optional(),
  textContains: z.string().max(120).optional(),
  maxPriceMinorUnits: z.number().int().nonnegative().optional(),
  minPriceMinorUnits: z.number().int().nonnegative().optional(),
});
export type SmartListQuery = z.infer<typeof SmartListQuerySchema>;
