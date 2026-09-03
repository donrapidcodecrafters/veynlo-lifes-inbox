import { and, eq, isNull, isNotNull, ne } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";

/**
 * Every column of `identity_records` EXCEPT `document_number` — the one field this whole domain treats as
 * "reveal requires recent authentication" (see identity-records.service.ts's `revealDocumentNumber`). Any
 * query that isn't that dedicated, step-up-gated reveal path (list/detail here, the Trips/Attention/
 * Emergency-Binder cross-domain reads elsewhere) selects exactly this column set instead of `.select()`'s
 * implicit "everything," so a plain-text passport/license number never round-trips through application
 * memory (or a log line, or another domain's response payload) outside that one gated method.
 */
export const identityRecordSafeColumns = {
  id: schema.identityRecords.id,
  ownerUserId: schema.identityRecords.ownerUserId,
  householdId: schema.identityRecords.householdId,
  recordType: schema.identityRecords.recordType,
  label: schema.identityRecords.label,
  issuingAuthority: schema.identityRecords.issuingAuthority,
  issuedDate: schema.identityRecords.issuedDate,
  expirationDate: schema.identityRecords.expirationDate,
  expirationDateSort: schema.identityRecords.expirationDateSort,
  linkedVehicleId: schema.identityRecords.linkedVehicleId,
  linkedPropertyId: schema.identityRecords.linkedPropertyId,
  linkedDocumentId: schema.identityRecords.linkedDocumentId,
  jurisdiction: schema.identityRecords.jurisdiction,
  renewalUrl: schema.identityRecords.renewalUrl,
  reminderLeadDays: schema.identityRecords.reminderLeadDays,
  status: schema.identityRecords.status,
  supersededByRecordId: schema.identityRecords.supersededByRecordId,
  sensitivity: schema.identityRecords.sensitivity,
  visibility: schema.identityRecords.visibility,
  createdAt: schema.identityRecords.createdAt,
  updatedAt: schema.identityRecords.updatedAt,
  deletedAt: schema.identityRecords.deletedAt,
} as const;

export type IdentityRecordSafeRow = {
  [K in keyof typeof identityRecordSafeColumns]: (typeof schema.identityRecords.$inferSelect)[K];
};

/**
 * TRIP-006 "Travel document readiness" / ID-001's own "warn earlier ... where trip destination validity
 * rules may matter" — this dedicated `identity_records` domain is now the more authoritative source for a
 * user's passport than the generic Documents vault's `documentKind==="passport"` fallback TripsService and
 * AttentionService both originally read (built earlier this session, before this domain existed). Used by
 * both `TripsService.computeDocumentReadiness` and `AttentionService.scanAndFileDeadlines`'s travel-document
 * block — kept here as a plain exported function (not a NestJS-injected service method) so neither module
 * needs a new module dependency, same "shared plain function, not a service-to-service DI edge" shape
 * `resolvePriceAdjustmentPolicy` already uses across commerce/ingestion.
 *
 * Returns only non-deleted, non-"renewed" (i.e. still-current) passport records with a known expiration —
 * an empty array means "this owner has no dedicated passport record yet," the caller's own cue to fall back
 * to the Documents-vault heuristic instead (never a silent regression for a user who hasn't migrated).
 */
export async function listActivePassportRecords(db: Database, ownerUserId: string): Promise<IdentityRecordSafeRow[]> {
  return db
    .select(identityRecordSafeColumns)
    .from(schema.identityRecords)
    .where(
      and(
        eq(schema.identityRecords.ownerUserId, ownerUserId),
        eq(schema.identityRecords.recordType, "passport"),
        ne(schema.identityRecords.status, "renewed"),
        isNull(schema.identityRecords.deletedAt),
        isNotNull(schema.identityRecords.expirationDateSort),
      ),
    );
}
