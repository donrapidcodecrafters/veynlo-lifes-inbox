import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

@Injectable()
export class FeatureFlagsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** A key with no row is off — this is a kill switch, so "not yet configured" must mean disabled, never enabled. */
  async isEnabled(key: string): Promise<boolean> {
    const [row] = await this.db.select({ enabled: schema.featureFlags.enabled }).from(schema.featureFlags).where(eq(schema.featureFlags.key, key)).limit(1);
    return row?.enabled ?? false;
  }

  async list() {
    return this.db.select().from(schema.featureFlags).orderBy(schema.featureFlags.key);
  }

  /** Upserts so an admin can flip a flag that doesn't have a row yet without a separate "create" step. */
  async setEnabled(key: string, enabled: boolean, description?: string) {
    const [existing] = await this.db.select().from(schema.featureFlags).where(eq(schema.featureFlags.key, key)).limit(1);
    if (existing) {
      await this.db
        .update(schema.featureFlags)
        .set({ enabled, updatedAt: new Date(), ...(description ? { description } : {}) })
        .where(eq(schema.featureFlags.key, key));
    } else {
      await this.db.insert(schema.featureFlags).values({ key, enabled, description: description ?? key });
    }
    return { key, enabled };
  }
}
