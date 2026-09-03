import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
// A recurring trigger (person_birthday) refires at most once per ~300 days — comfortably under a year so
// this year's occurrence always lands inside a later daily scan, but far enough that the same occurrence
// can never double-fire.
const RECURRENCE_GAP_MS = 300 * 24 * 60 * 60 * 1000;
// location_proximity is event-driven (one real geofence arrival at a time), not scan-tick-driven — a much
// shorter cooldown than RECURRENCE_GAP_MS so a genuinely useful "you're at Costco again" reminder isn't
// suppressed for months, while still not re-filing on every arrival within the same visit/day (a geofence
// can fire more than once in quick succession as a device's GPS fix wobbles near the region boundary).
const LOCATION_RECURRENCE_GAP_MS = 12 * 60 * 60 * 1000;

/**
 * §29.1 SAVE-004 "Contextual resurfacing" — resurfaces saved items relevant to date/person/trip/location.
 * A real rule-evaluation pass, mirroring AttentionService.scanAndFileDeadlines in shape: runs on a
 * recurring worker tick (see queue-names.ts's ResurfacingScanJobData), reads `resurfacing_rules`, and files
 * into the SAME `attention_items` table the Home "Needs You" queue already reads — resurfacing a saved
 * memory is exactly as attention-worthy as a bill coming due, and reusing that table means no second
 * "things you should look at" feed needs to be built or rendered anywhere.
 *
 * Five trigger types exist; four are live here on the periodic scan tick, one is event-driven:
 *   - `date` — a user-chosen date (SAVE-001 "request resurfacing rule"), fires once, then the rule
 *     deactivates (a specific date only ever occurs once).
 *   - `person_birthday` — computed from `dependentProfiles.birthDate`, already tracked by the household
 *     domain; recurs yearly (see RECURRENCE_GAP_MS above), matching "gift ideas surface before a chosen
 *     person's birthday" literally.
 *   - `trip_location` — "saved Denver restaurants surface while planning a Denver trip" literally: matches
 *     `resurfacing_rules.triggerConfig.locationLabel` against the owner's own upcoming/active trips
 *     (packages/db/src/schema/travel.ts's `trips.destinationLabel`, from the concurrently-built Travel
 *     domain) by case-insensitive substring, either direction. Reads the `trips` table directly rather than
 *     going through TripsService — same "cross-domain read of another module's table" precedent as
 *     AttentionService reading bills/warranties/subscriptions directly — since only a plain read of
 *     destination/date-range/status is needed, not any of TripsService's write-side business logic.
 *   - `location_proximity` — deliberately NOT evaluated on this scan tick at all (see the switch below):
 *     it fires the instant a real on-device geofence arrival is reported for the linked place, via
 *     `fireLocationProximityResurfacing`, called directly from `LocationService.recordGeofenceEvent`. A
 *     periodic scan has nothing useful to check for this trigger between arrivals — there's no "getting
 *     closer to due" the way a date/birthday has.
 *
 * `query_based` resurfacing (the fifth SAVE-004 trigger) has no row in `resurfacing_rules` at all and
 * nothing here evaluates it — see MemoriesService.relatedForQuery's own doc comment for why it's a live
 * secondary ranking pass alongside an actual search/ask, not an independently-firing trigger.
 */
@Injectable()
export class ResurfacingService {
  private readonly logger = new Logger(ResurfacingService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async scanAndFileResurfacing(): Promise<void> {
    await this.autoArchiveDueItems();

    const now = new Date();
    const rules = await this.db.select().from(schema.resurfacingRules).where(eq(schema.resurfacingRules.active, true));
    if (rules.length === 0) return;

    const memoryIds = [...new Set(rules.map((r) => r.savedMemoryId))];
    const memories = await this.db.select().from(schema.savedMemories).where(inArray(schema.savedMemories.id, memoryIds));
    const memoryById = new Map(memories.map((m) => [m.id, m] as const));

    for (const rule of rules) {
      const memory = memoryById.get(rule.savedMemoryId);
      // SAVE-007 "never resurface automatically" / archived items don't resurface either — a rule whose
      // memory no longer exists, was archived, or opted out is simply skipped, never deleted here (the
      // user's own archive/never-resurface toggle is the source of truth, not this scan).
      if (!memory || memory.archivedAt || memory.neverResurface) continue;

      if (rule.triggerType === "date") {
        await this.evaluateDateRule(rule, memory, now);
      } else if (rule.triggerType === "person_birthday") {
        await this.evaluateBirthdayRule(rule, memory, now);
      } else if (rule.triggerType === "trip_location") {
        await this.evaluateTripLocationRule(rule, memory, now);
      } else if (rule.triggerType === "location_proximity") {
        // Event-driven only — see this class's own doc comment. Nothing to do on a periodic tick.
      } else {
        this.logger.warn(`Resurfacing rule ${rule.id} has unrecognized trigger type "${rule.triggerType}" — skipping.`);
      }
    }
  }

  /** SAVE-007 "auto-archive after a condition." */
  private async autoArchiveDueItems(): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.savedMemories)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(lte(schema.savedMemories.autoArchiveAt, now), isNull(schema.savedMemories.archivedAt)));
  }

  private async evaluateDateRule(rule: typeof schema.resurfacingRules.$inferSelect, memory: typeof schema.savedMemories.$inferSelect, now: Date): Promise<void> {
    if (rule.lastFiredAt) return; // one-shot — already fired once, ever
    const config = rule.triggerConfig as { date?: string };
    if (!config.date) return;
    const target = new Date(config.date);
    if (Number.isNaN(target.getTime()) || target < now || target > new Date(now.getTime() + LOOKAHEAD_MS)) return;

    await this.fileResurfacing({
      ownerUserId: rule.ownerUserId,
      savedMemoryId: memory.id,
      reasonCode: "memory_resurface_date",
      reasonText: `You asked to be reminded about "${memory.title ?? "a saved item"}" around now.`,
      dueAtSort: target,
    });
    // One-shot: a specific date only ever occurs once, so the rule is spent — deactivated rather than
    // deleted, so the user can still see it was created and when it fired.
    await this.db.update(schema.resurfacingRules).set({ active: false, lastFiredAt: now }).where(eq(schema.resurfacingRules.id, rule.id));
  }

  private async evaluateBirthdayRule(
    rule: typeof schema.resurfacingRules.$inferSelect,
    memory: typeof schema.savedMemories.$inferSelect,
    now: Date,
  ): Promise<void> {
    if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < RECURRENCE_GAP_MS) return;
    const config = rule.triggerConfig as { dependentProfileId?: string; daysBefore?: number };
    if (!config.dependentProfileId) return;

    const [dependent] = await this.db
      .select()
      .from(schema.dependentProfiles)
      .where(eq(schema.dependentProfiles.id, config.dependentProfileId))
      .limit(1);
    if (!dependent?.birthDate) return;
    const birthDate = new Date(dependent.birthDate);
    if (Number.isNaN(birthDate.getTime())) return;

    // Next occurrence of this month/day at or after today (year rolls forward if it's already passed this year).
    let nextBirthday = new Date(Date.UTC(now.getUTCFullYear(), birthDate.getUTCMonth(), birthDate.getUTCDate()));
    if (nextBirthday < now) nextBirthday = new Date(Date.UTC(now.getUTCFullYear() + 1, birthDate.getUTCMonth(), birthDate.getUTCDate()));

    const daysBefore = config.daysBefore ?? 14;
    const remindAt = new Date(nextBirthday.getTime() - daysBefore * 86_400_000);
    if (remindAt > now) return; // not yet time — a later daily tick will catch it

    const daysUntilBirthday = Math.max(0, Math.round((nextBirthday.getTime() - now.getTime()) / 86_400_000));
    await this.fileResurfacing({
      ownerUserId: rule.ownerUserId,
      savedMemoryId: memory.id,
      reasonCode: "memory_resurface_birthday",
      reasonText: `${dependent.displayName}'s birthday is in ${daysUntilBirthday} day${daysUntilBirthday === 1 ? "" : "s"} — you saved "${memory.title ?? "a gift idea"}" for them.`,
      dueAtSort: nextBirthday,
    });
    await this.db.update(schema.resurfacingRules).set({ lastFiredAt: now }).where(eq(schema.resurfacingRules.id, rule.id));
  }

  /** SAVE-004 "saved Denver restaurants surface while planning a Denver trip." Recurs like the birthday
   * rule (RECURRENCE_GAP_MS) rather than one-shot like the date rule: a new trip to the same place months
   * later is exactly the kind of second occasion this should resurface for again. */
  private async evaluateTripLocationRule(
    rule: typeof schema.resurfacingRules.$inferSelect,
    memory: typeof schema.savedMemories.$inferSelect,
    now: Date,
  ): Promise<void> {
    if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < RECURRENCE_GAP_MS) return;
    const config = rule.triggerConfig as { locationLabel?: string };
    const needle = config.locationLabel?.trim().toLowerCase();
    if (!needle) return;

    const trips = await this.db
      .select()
      .from(schema.trips)
      .where(and(eq(schema.trips.ownerUserId, rule.ownerUserId), or(eq(schema.trips.status, "upcoming"), eq(schema.trips.status, "active"))!, isNull(schema.trips.deletedAt)));
    const match = trips.find((t) => t.destinationLabel && (t.destinationLabel.toLowerCase().includes(needle) || needle.includes(t.destinationLabel.toLowerCase())));
    if (!match) return;

    await this.fileResurfacing({
      ownerUserId: rule.ownerUserId,
      savedMemoryId: memory.id,
      reasonCode: "memory_resurface_trip_location",
      reasonText: `You're planning a trip to ${match.destinationLabel} — you saved "${memory.title ?? "something"}" for ${config.locationLabel}.`,
      dueAtSort: match.startDateSort ?? now,
    });
    await this.db.update(schema.resurfacingRules).set({ lastFiredAt: now }).where(eq(schema.resurfacingRules.id, rule.id));
  }

  /**
   * SAVE-004 "location-proximity" — called directly from `LocationService.recordGeofenceEvent` the moment
   * the OS reports a real arrival at a geofenced place (never on a poll/interval — see location.ts
   * schema's own LOC-006 doc comment on why this codebase never does that). Finds every active
   * `location_proximity` rule pointed at this exact place (via `triggerConfig.placeId`, matched in
   * application code — plain jsonb, no index, but this only ever runs once per real arrival event, not on
   * a hot path) and files a resurfacing for each one whose memory hasn't opted out and whose own
   * per-rule cooldown (LOCATION_RECURRENCE_GAP_MS) has elapsed. Returns how many actually fired, purely so
   * the caller can report it back (LocationService.recordGeofenceEvent already returns a `rulesFired`
   * count for context_rules; this is the analogous count for resurfacing).
   */
  async fireLocationProximityResurfacing(ownerUserId: string, placeId: string): Promise<number> {
    const now = new Date();
    const rules = await this.db
      .select()
      .from(schema.resurfacingRules)
      .where(and(eq(schema.resurfacingRules.ownerUserId, ownerUserId), eq(schema.resurfacingRules.triggerType, "location_proximity"), eq(schema.resurfacingRules.active, true)));
    const matching = rules.filter((r) => (r.triggerConfig as { placeId?: string }).placeId === placeId);
    if (matching.length === 0) return 0;

    const memoryIds = [...new Set(matching.map((r) => r.savedMemoryId))];
    const memories = await this.db.select().from(schema.savedMemories).where(inArray(schema.savedMemories.id, memoryIds));
    const memoryById = new Map(memories.map((m) => [m.id, m] as const));
    const [place] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId)).limit(1);

    let fired = 0;
    for (const rule of matching) {
      if (rule.lastFiredAt && now.getTime() - rule.lastFiredAt.getTime() < LOCATION_RECURRENCE_GAP_MS) continue;
      const memory = memoryById.get(rule.savedMemoryId);
      if (!memory || memory.archivedAt || memory.neverResurface) continue;

      await this.fileResurfacing({
        ownerUserId,
        savedMemoryId: memory.id,
        reasonCode: "memory_resurface_location_proximity",
        reasonText: `You're near ${place?.label ?? "a saved place"} — you saved "${memory.title ?? "something"}" for here.`,
        dueAtSort: now,
      });
      await this.db.update(schema.resurfacingRules).set({ lastFiredAt: now }).where(eq(schema.resurfacingRules.id, rule.id));
      fired += 1;
    }
    return fired;
  }

  /**
   * Deliberately does NOT reuse AttentionService.fileIfNew's "any existing row ever for this resource"
   * dedup — that's correct for a one-time deadline, but would permanently block a YEARLY birthday reminder
   * from ever firing again after its first year. The recurrence guard instead lives on the RULE
   * (`resurfacing_rules.lastFiredAt`, checked by evaluateDateRule/evaluateBirthdayRule before this is ever
   * called), which is why this can just insert unconditionally — by the time execution reaches here, the
   * caller has already established this specific occurrence hasn't been filed yet. Relies on
   * resurfacingScanWorker running at concurrency 1 (worker-main.ts) so two ticks can never race between the
   * gap-check and this insert.
   */
  private async fileResurfacing(item: { ownerUserId: string; savedMemoryId: string; reasonCode: string; reasonText: string; dueAtSort: Date }): Promise<void> {
    await this.db.insert(schema.attentionItems).values({
      id: generateId("attentionItem"),
      ownerUserId: item.ownerUserId,
      householdId: null,
      reasonCode: item.reasonCode,
      reasonText: item.reasonText,
      urgency: "useful",
      dueAt: null,
      dueAtSort: item.dueAtSort,
      moneyAtStakeMinorUnits: null,
      moneyAtStakeCurrency: null,
      confidenceBand: "verified",
      linkedResourceType: "saved_memory",
      linkedResourceId: item.savedMemoryId,
      primaryActions: ["view_memory"],
    });
  }
}
