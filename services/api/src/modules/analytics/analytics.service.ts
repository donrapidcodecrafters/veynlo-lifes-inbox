import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { ClientPlatform } from "../../common/platform";

/**
 * §48 "Product Analytics, Experimentation & Growth" — the fixed vocabulary `AnalyticsService.track`
 * accepts, drawn from §Appendix F "Product Analytics Event Taxonomy" wherever a literal match exists.
 *
 * Two names go beyond Appendix F's literal list, both deliberately and both documented here rather than
 * silently invented:
 *   - `item_caught` — §48.1's north-star candidate is "weekly users/households with at least one
 *     meaningful item caught, resolved or automatically organized in time; weekly 'caught it for me'
 *     events," which needs a per-occurrence event fired every time something is filed. Appendix F's
 *     closest entries (`first_discovery_created`, `first_action_completed`) are explicitly one-time
 *     onboarding milestones, not a recurring signal — so the north-star metric has nothing to count without
 *     this addition.
 *   - `first_discovery_created` — IS in Appendix F; emitted only the very first time a given user gets an
 *     `item_caught`, gating §48.1 Activation's "connection→first meaningful discovery, time-to-first-value."
 */
export const PRODUCT_EVENT_NAMES = [
  "signup_completed",
  "capture_processed",
  "item_caught",
  "first_discovery_created",
  "search_submitted",
  "subscription_started",
  "subscription_upgraded",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

/**
 * Coarser than `devices.platform`/`ClientPlatform`'s ios/android/web/macos/windows/extension split — product
 * analytics only needs "phone app" vs "browser" vs "internal admin console" vs "no live client at all"
 * (a billing webhook, a background job), not exact OS. `"server"` covers the last case.
 */
export type AnalyticsPlatform = "web" | "mobile" | "admin" | "server";

/** Maps a request's fine-grained `ClientPlatform` (services/api/src/common/platform.ts) down to the
 * coarser bucket `product_events.platform` actually stores. */
export function toAnalyticsPlatform(platform: ClientPlatform | string): AnalyticsPlatform {
  return platform === "ios" || platform === "android" ? "mobile" : "web";
}

const FORBIDDEN_PROPERTY_KEY_SUBSTRINGS = [
  "email",
  "phone",
  "address",
  "name",
  "body",
  "subject",
  "snippet",
  "question",
  "query",
  "note",
  "transcript",
  "content",
  "message",
  "description",
  "ssn",
  "dob",
  "card",
  "iban",
  "password",
  "secret",
  "token",
  "ocr",
  "rawtext",
  "location",
  "lat",
  "lng",
  "ip",
];

const MAX_PROPERTY_KEYS = 20;
const MAX_PROPERTY_STRING_LENGTH = 100;

/**
 * §48.2 "Analytics events record product behavior, not raw private payloads... Never send full financial
 * transaction descriptions, health notes, identity numbers, precise location trails or private document
 * text to general analytics." — the actual enforcement point, not just a naming convention. Every call site
 * in this codebase passes hand-built small property bags (a category enum, a plan key, a boolean, a count),
 * so this exists as a structural backstop against a future call site accidentally forwarding something
 * bigger (a whole DTO, a raw record) rather than as the primary defense — defense in depth, not a complete
 * DLP system. Throws (never silently redacts) so a violation is loud in tests/logs rather than quietly
 * dropping half of what was meant to be recorded.
 */
export function sanitizeAnalyticsProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(properties);
  if (keys.length > MAX_PROPERTY_KEYS) {
    throw new Error(`Analytics properties carry ${keys.length} keys — that's too many for small structured metadata (§48.2).`);
  }
  const sanitized: Record<string, unknown> = {};
  for (const key of keys) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error(`Analytics property key "${key}" isn't a plain snake_case identifier — rejected rather than guessed at.`);
    }
    const lowerKey = key.toLowerCase();
    const forbiddenWord = FORBIDDEN_PROPERTY_KEY_SUBSTRINGS.find((word) => lowerKey.includes(word));
    if (forbiddenWord) {
      throw new Error(`Analytics property key "${key}" matches forbidden term "${forbiddenWord}" — looks like it could carry private content (§48.2).`);
    }
    const value = properties[key];
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      sanitized[key] = value;
      continue;
    }
    if (typeof value === "string") {
      if (value.length > MAX_PROPERTY_STRING_LENGTH) {
        throw new Error(`Analytics property "${key}" is ${value.length} chars — too long for structured metadata, looks like raw content (§48.2).`);
      }
      if (value.includes("@")) {
        throw new Error(`Analytics property "${key}" contains "@" — looks like it could be an email address (§48.2).`);
      }
      sanitized[key] = value;
      continue;
    }
    throw new Error(`Analytics property "${key}" has an unsupported type (${typeof value}) — only string/number/boolean/null are allowed (§48.2).`);
  }
  return sanitized;
}

export interface TrackInput {
  userId?: string | null;
  householdId?: string | null;
  platform: AnalyticsPlatform;
  properties?: Record<string, unknown>;
}

/**
 * Thin, reusable emission point for §48's product-analytics event log — every call site in the codebase
 * should go through `track()` rather than inserting into `product_events` directly, the same "one funnel
 * point" discipline `IngestionService.fileInboxItem`'s own doc comment already uses for automation triggers.
 *
 * Deliberately never throws to its caller: a bug in analytics (a bad property, a DB hiccup) must never fail
 * the real product journey it's only there to observe — same "log loudly, never break the primary path"
 * posture as `IngestionService.fileInboxItem`'s own try/catch around automation evaluation. A rejected
 * (unsanitary) call simply isn't recorded; nothing about it can also break signup, ingestion, Ask or
 * checkout.
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async track(eventName: ProductEventName, input: TrackInput): Promise<void> {
    try {
      const properties = sanitizeAnalyticsProperties(input.properties ?? {});
      await this.db.insert(schema.productEvents).values({
        id: generateId("productEvent"),
        eventName,
        userId: input.userId ?? null,
        householdId: input.householdId ?? null,
        platform: input.platform,
        properties,
      });
    } catch (err) {
      this.logger.error(`Failed to record product event "${eventName}": ${String(err)}`);
    }
  }

  /**
   * §48.1 Activation "connection→first meaningful discovery" — fires `first_discovery_created` (Appendix
   * F) the first time (and only the first time) this user has ANY `item_caught` row, alongside the
   * recurring `item_caught` itself (see `PRODUCT_EVENT_NAMES`'s own doc comment for why both exist).
   * Ordering matters: the existence check runs before this occurrence is inserted, so the row this call
   * itself is about to write is never mistaken for a prior one.
   */
  async trackItemCaught(input: TrackInput & { userId: string }): Promise<void> {
    let isFirstEver = false;
    try {
      const [existing] = await this.db
        .select({ id: schema.productEvents.id })
        .from(schema.productEvents)
        .where(and(eq(schema.productEvents.userId, input.userId), eq(schema.productEvents.eventName, "item_caught")))
        .limit(1);
      isFirstEver = !existing;
    } catch (err) {
      this.logger.error(`Failed to check prior item_caught history for user: ${String(err)}`);
    }
    await this.track("item_caught", input);
    if (isFirstEver) {
      await this.track("first_discovery_created", { ...input, properties: {} });
    }
  }
}
