import { z } from "zod";

/** Phase 2 §52.2 "bulk management" (spec DSK-004) — the Documents page's multi-select delete. */
export const BulkDeleteDocumentsDtoSchema = z.object({
  ids: z.array(z.string()).min(1).max(200),
});
export type BulkDeleteDocumentsDto = z.infer<typeof BulkDeleteDocumentsDtoSchema>;

// The object-sharing DTOs (CreateResourceGrantDtoSchema/CreateShareLinkDtoSchema/AccessShareLinkDtoSchema)
// used to live here, document-only. They're now generic across every shareable resource type — see
// ../sharing/dto.ts.

/**
 * Phase 3 §26 TRIP-006 "Travel document readiness" — the minimal identity-document concept added to the
 * existing Documents vault (see documents.ts's `documentKind`/`expiresAt` schema doc comment). Both
 * fields are user-set only; `documentKind` isn't a closed enum server-side (any short label the user
 * types), but the web/mobile UI only ever offers a small fixed set headed by "passport" — the one kind
 * TripsService/AttentionService actually read.
 */
export const SetDocumentTravelInfoDtoSchema = z.object({
  documentKind: z.string().max(60).nullable(),
  expiresAtIso: z.string().nullable(),
});
export type SetDocumentTravelInfoDto = z.infer<typeof SetDocumentTravelInfoDtoSchema>;

/**
 * §40.3 Document state machine's "superseded" — the explicit user-confirmed counterpart to
 * `DocumentsService.upload`'s automatic exact-content-hash supersede path, for a corrected/amended
 * document whose bytes differ from the original (e.g. an amended lease). Called on the OLD document with
 * the id of its replacement.
 */
export const MarkSupersededDtoSchema = z.object({
  replacedByDocumentId: z.string().min(1),
});
export type MarkSupersededDto = z.infer<typeof MarkSupersededDtoSchema>;

/** §27/§40.3 generic "link this document to a domain record" primitive — see
 * DocumentsService.linkToEntity's own doc comment for why this exists alongside the
 * HealthLogisticsService-specific `linkedEntityIds` writer. */
export const LinkDocumentToEntityDtoSchema = z.object({
  entityId: z.string().min(1),
});
export type LinkDocumentToEntityDto = z.infer<typeof LinkDocumentToEntityDtoSchema>;

/** `GET /v1/documents?filter=` — which processingState bucket to return; see DocumentsService.list's own
 * doc comment for what each value excludes/includes. */
export const DocumentListFilterSchema = z.enum(["active", "archived", "superseded", "all"]).default("active");
export type DocumentListFilter = z.infer<typeof DocumentListFilterSchema>;
