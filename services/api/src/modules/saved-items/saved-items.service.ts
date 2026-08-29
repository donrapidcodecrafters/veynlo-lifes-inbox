import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/**
 * SAVE-001/SAVE-002 "save anything" — private by default per spec (no household-delegated read path here,
 * unlike DocumentsService/CommerceService's `ownerOrDelegatedHousehold`; "sharing explicit" from the spec's
 * own permissions line isn't built yet — see docs/ROADMAP.md for that scope call).
 */
@Injectable()
export class SavedItemsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(
    ownerUserId: string,
    dto: {
      title: string;
      url?: string;
      note?: string;
      tags?: string[];
      category?: string;
      address?: string;
      latitude?: number;
      longitude?: number;
    },
  ) {
    const id = generateId("savedItem");
    await this.db.insert(schema.savedItems).values({
      id,
      ownerUserId,
      title: dto.title,
      url: dto.url ?? null,
      note: dto.note ?? null,
      tags: dto.tags ?? [],
      category: dto.category ?? "generic",
      address: dto.address ?? null,
      latitude: dto.latitude ?? null,
      longitude: dto.longitude ?? null,
    });
    return { id };
  }

  async list(ownerUserId: string, filter: { archived?: boolean; category?: string } = {}) {
    const conditions = [eq(schema.savedItems.ownerUserId, ownerUserId)];
    // Archived items are hidden by default (matches the spec's "archive" action being a way to get
    // something out of the primary view without deleting it) — pass archived:true explicitly to see them.
    conditions.push(eq(schema.savedItems.archived, filter.archived ?? false));
    if (filter.category) conditions.push(eq(schema.savedItems.category, filter.category));
    return this.db
      .select()
      .from(schema.savedItems)
      .where(and(...conditions))
      .orderBy(desc(schema.savedItems.pinned), desc(schema.savedItems.createdAt));
  }

  async update(
    id: string,
    ownerUserId: string,
    dto: {
      title?: string;
      note?: string;
      tags?: string[];
      pinned?: boolean;
      archived?: boolean;
      address?: string;
      latitude?: number;
      longitude?: number;
    },
  ) {
    await this.assertOwned(id, ownerUserId);
    const patch: Partial<typeof schema.savedItems.$inferInsert> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.note !== undefined) patch.note = dto.note;
    if (dto.tags !== undefined) patch.tags = dto.tags;
    if (dto.pinned !== undefined) patch.pinned = dto.pinned;
    if (dto.archived !== undefined) patch.archived = dto.archived;
    if (dto.address !== undefined) patch.address = dto.address;
    if (dto.latitude !== undefined) patch.latitude = dto.latitude;
    if (dto.longitude !== undefined) patch.longitude = dto.longitude;
    await this.db.update(schema.savedItems).set(patch).where(eq(schema.savedItems.id, id));
  }

  async delete(id: string, ownerUserId: string) {
    await this.assertOwned(id, ownerUserId);
    await this.db.delete(schema.savedItems).where(eq(schema.savedItems.id, id));
  }

  private async assertOwned(id: string, ownerUserId: string) {
    const [item] = await this.db.select().from(schema.savedItems).where(eq(schema.savedItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "SAVED_ITEM_NOT_FOUND", message: "Not found." });
    if (item.ownerUserId !== ownerUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your saved item." });
    return item;
  }
}
