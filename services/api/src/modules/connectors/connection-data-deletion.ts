import { and, eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import type { SearchResourceType } from "../search/search-index.service";

export interface ConnectionDataDeletionInput {
  connectionId: string;
  ownerUserId: string;
}

/**
 * PRIV-002 - the actual deletion half of "disconnect and delete" (ConnectorsService.disconnect marks the
 * connection disconnected synchronously; this does the real work). Only one domain table traces back to a
 * connection directly (purchases.sourceEventId); bills/warranties/calendar_events/shipments have no such
 * column, so they're found indirectly via inbox_items - every successful extraction files one
 * (IngestionService.fileInboxItem), and nothing in the app hard-deletes an inbox_item, so that mapping is
 * reliable. Deletes purchases first so return_cases/shipments/purchase_lines that FK to them cascade away
 * automatically; captures purchaseLines.ownerAssetEntityId beforehand since canonical_entities has no
 * matching cascade and would otherwise orphan. Also clears any attention_item pointing at something about
 * to be deleted, so "Needs You" never shows a card for data that no longer exists. Documents are
 * deliberately out of scope - they're user-uploaded (documents.service.ts's upload()), not
 * connector-derived, so a connection has none to delete.
 *
 * Lifted out of worker-main.ts's inline worker body so it can actually be tested - which is how the
 * search-index gap below went unnoticed.
 */
export async function deleteConnectionData(db: Database, { connectionId, ownerUserId }: ConnectionDataDeletionInput): Promise<void> {
  const sourceEventRows = await db
    .select({ id: schema.sourceEvents.id })
    .from(schema.sourceEvents)
    .where(eq(schema.sourceEvents.connectionId, connectionId));
  const sourceEventIds = sourceEventRows.map((r) => r.id);
  if (sourceEventIds.length === 0) return;

  const purchases = await db.select({ id: schema.purchases.id }).from(schema.purchases).where(inArray(schema.purchases.sourceEventId, sourceEventIds));
  const purchaseIds = purchases.map((p) => p.id);

  // Collected BEFORE the purchases delete, because both cascade away with it and their search-index rows
  // would then be unreachable - an id that no longer exists anywhere cannot be looked up afterwards.
  const cascadedShipmentIds: string[] = [];
  const cascadedReturnCaseIds: string[] = [];
  if (purchaseIds.length > 0) {
    const shipmentRows = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(inArray(schema.shipments.purchaseId, purchaseIds));
    cascadedShipmentIds.push(...shipmentRows.map((r) => r.id));
    const returnRows = await db.select({ id: schema.returnCases.id }).from(schema.returnCases).where(inArray(schema.returnCases.purchaseId, purchaseIds));
    cascadedReturnCaseIds.push(...returnRows.map((r) => r.id));
  }

  if (purchaseIds.length > 0) {
    const lines = await db
      .select({ ownerAssetEntityId: schema.purchaseLines.ownerAssetEntityId })
      .from(schema.purchaseLines)
      .where(inArray(schema.purchaseLines.purchaseId, purchaseIds));
    const entityIds = lines.map((l) => l.ownerAssetEntityId).filter((id): id is string => id != null);
    await db.delete(schema.purchases).where(inArray(schema.purchases.id, purchaseIds));
    if (entityIds.length > 0) await db.delete(schema.canonicalEntities).where(inArray(schema.canonicalEntities.id, entityIds));
  }

  const inboxRows = await db
    .select({ linkedResourceType: schema.inboxItems.linkedResourceType, linkedResourceId: schema.inboxItems.linkedResourceId })
    .from(schema.inboxItems)
    .where(inArray(schema.inboxItems.sourceEventId, sourceEventIds));
  const idsFor = (type: string) => inboxRows.filter((r) => r.linkedResourceType === type && r.linkedResourceId).map((r) => r.linkedResourceId as string);
  const billIds = idsFor("bill");
  const warrantyIds = idsFor("warranty");
  const calendarEventIds = idsFor("calendar_event");
  const shipmentIds = idsFor("shipment");
  // MAIL-008 audit fix: store credits were the one extractor-produced domain object this worker never
  // purged - extractStoreCredit (ingestion.service.ts) writes a real sourceEventId onto storeCredits
  // exactly like bills/warranties do, but nothing here ever deleted it, so "Disconnect & delete data"
  // silently left store-credit rows (and their attention items) behind for this connection.
  const storeCreditIds = idsFor("store_credit");
  if (billIds.length > 0) await db.delete(schema.bills).where(inArray(schema.bills.id, billIds));
  if (warrantyIds.length > 0) await db.delete(schema.warranties).where(inArray(schema.warranties.id, warrantyIds));
  if (calendarEventIds.length > 0) await db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, calendarEventIds));
  if (shipmentIds.length > 0) await db.delete(schema.shipments).where(inArray(schema.shipments.id, shipmentIds));
  if (storeCreditIds.length > 0) await db.delete(schema.storeCredits).where(inArray(schema.storeCredits.id, storeCreditIds));

  const allLinkedIds = [...purchaseIds, ...billIds, ...warrantyIds, ...calendarEventIds, ...shipmentIds, ...storeCreditIds];
  if (allLinkedIds.length > 0) await db.delete(schema.attentionItems).where(inArray(schema.attentionItems.linkedResourceId, allLinkedIds));

  /**
   * The search index is derived state exactly like the attention items cleared above, and it was the one
   * derived table this worker never touched. Six of the twelve indexed resource types - purchase, bill,
   * warranty, subscription, shipment, return_case - have no SearchIndexService.markDeleted caller anywhere,
   * because unlike documents/pets/trips they are hard-deleted rather than soft-deleted, and this worker is
   * where that hard delete happens.
   *
   * Two consequences, and the first is the serious one. search_documents.title and body_text are
   * deliberately PLAINTEXT (the source columns are encrypted at rest and cannot be searched, which is the
   * whole point of the index) - so "Disconnect & delete data" left a readable copy of the deleted purchases
   * and bills behind indefinitely. That is the same problem the search_documents.owner_user_id foreign key
   * fixed for account deletion, arriving through a different door. Second, SearchService hydrates every hit
   * from its source table, so a stranded row silently drops out of the result list and the user sees fewer
   * results than the search reported finding.
   *
   * Hard-deleted rather than soft-deleted, unlike markDeleted: the source rows here are hard-deleted, and a
   * soft-deleted index row would keep that plaintext copy in the database, which is the thing being fixed.
   */
  const indexTargets: Array<[SearchResourceType, string[]]> = [
    ["purchase", purchaseIds],
    ["bill", billIds],
    ["warranty", warrantyIds],
    ["calendar_event", calendarEventIds],
    ["shipment", [...shipmentIds, ...cascadedShipmentIds]],
    ["return_case", cascadedReturnCaseIds],
  ];
  for (const [resourceType, ids] of indexTargets) {
    if (ids.length === 0) continue;
    await db
      .delete(schema.searchDocuments)
      .where(and(eq(schema.searchDocuments.resourceType, resourceType), inArray(schema.searchDocuments.resourceId, ids)));
  }

  await db.delete(schema.inboxItems).where(inArray(schema.inboxItems.sourceEventId, sourceEventIds));
  await db.delete(schema.sourceEvents).where(inArray(schema.sourceEvents.id, sourceEventIds));

  await db.insert(schema.auditEvents).values({
    id: generateId("auditEvent"),
    actorType: "user",
    actorId: ownerUserId,
    action: "connection.delete_derived_data",
    resourceType: "connection",
    resourceId: connectionId,
    beforeJson: { sourceEventCount: sourceEventIds.length, purchaseCount: purchaseIds.length },
    result: "success",
  });
}
