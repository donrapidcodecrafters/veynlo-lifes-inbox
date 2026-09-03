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

  /** Upserts so an admin can flip a flag that doesn't have a row yet without a separate "create" step.
   * `value` is the optional numeric/string payload a few flags carry alongside their bool (see
   * `getNumericValue` below) — omitted (not `null`) leaves whatever value the row already has untouched, so
   * a plain enable/disable toggle never has to know or re-send a threshold it isn't changing. */
  async setEnabled(key: string, enabled: boolean, description?: string, value?: string) {
    const [existing] = await this.db.select().from(schema.featureFlags).where(eq(schema.featureFlags.key, key)).limit(1);
    if (existing) {
      await this.db
        .update(schema.featureFlags)
        .set({ enabled, updatedAt: new Date(), ...(description ? { description } : {}), ...(value !== undefined ? { value } : {}) })
        .where(eq(schema.featureFlags.key, key));
    } else {
      await this.db.insert(schema.featureFlags).values({ key, enabled, description: description ?? key, value: value ?? null });
    }
    return { key, enabled };
  }

  /** Raw string payload for a flag that carries more than a bare bool — null for an unconfigured/missing
   * flag or one that has never had a value set (every ordinary boolean-only flag). */
  async getValue(key: string): Promise<string | null> {
    const [row] = await this.db.select({ value: schema.featureFlags.value }).from(schema.featureFlags).where(eq(schema.featureFlags.key, key)).limit(1);
    return row?.value ?? null;
  }

  /** §47.4/§39.2 budget-guardrail thresholds (e.g. the historical-backfill cost-pressure pause) are the
   * first flags to need a real number rather than a bare bool — this is that read side. Falls back to
   * `fallback` for a missing row, an unset value, or a value that doesn't parse as a finite number, so a
   * malformed admin edit degrades to "use the built-in default" rather than crashing the caller. */
  async getNumericValue(key: string, fallback: number): Promise<number> {
    const raw = await this.getValue(key);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
