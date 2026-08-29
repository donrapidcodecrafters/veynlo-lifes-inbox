import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/**
 * Keeps `search_documents` (a real Postgres full-text search target — see its schema comment for why
 * title/bodyText are plaintext there while the source-of-truth columns elsewhere stay encrypted) in sync
 * with the resources it mirrors. One row per real resource, upserted on every create/update that changes
 * its searchable text, removed on delete — never the sole source of truth for anything, purely a search
 * index a writer keeps current.
 */
@Injectable()
export class SearchIndexService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async upsert(params: {
    resourceType: string;
    resourceId: string;
    ownerUserId: string;
    householdId: string | null;
    title: string;
    bodyText: string;
    /** No resource type this indexes has its own sensitivity column today — "sensitive" mirrors the one
     * established default in the codebase (documents.sensitivity), a conservative default until a real
     * per-type value exists to read instead of guess. */
    sensitivity?: string;
  }): Promise<void> {
    const sensitivity = params.sensitivity ?? "sensitive";
    await this.db
      .insert(schema.searchDocuments)
      .values({
        id: generateId("searchDocument"),
        ownerUserId: params.ownerUserId,
        householdId: params.householdId,
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        sensitivity,
        title: params.title,
        bodyText: params.bodyText,
        indexedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.searchDocuments.resourceType, schema.searchDocuments.resourceId],
        set: {
          ownerUserId: params.ownerUserId,
          householdId: params.householdId,
          sensitivity,
          title: params.title,
          bodyText: params.bodyText,
          indexedAt: new Date(),
        },
      });
  }

  async remove(resourceType: string, resourceId: string): Promise<void> {
    await this.db
      .delete(schema.searchDocuments)
      .where(and(eq(schema.searchDocuments.resourceType, resourceType), eq(schema.searchDocuments.resourceId, resourceId)));
  }

  /** AdminService.mergeMerchants/unmergeMerchants repoint many purchases' merchant in one bulk update
   * without loading each purchase's owner/household — a plain title rename on whatever's already indexed
   * (a no-op for any resourceId with no row yet) is all that's needed to keep search in sync with that. */
  async renameIndexedTitles(resourceType: string, resourceIds: string[], title: string): Promise<void> {
    if (resourceIds.length === 0) return;
    await this.db
      .update(schema.searchDocuments)
      .set({ title, indexedAt: new Date() })
      .where(and(eq(schema.searchDocuments.resourceType, resourceType), inArray(schema.searchDocuments.resourceId, resourceIds)));
  }
}
