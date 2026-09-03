import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, isNull, ne, or } from "drizzle-orm";
import { generateId, redactDollarAmounts } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { createSignedDeepLink } from "../../common/signed-deep-link";
import { PreferencesService } from "../preferences/preferences.service";
import type { SetWidgetPreferenceDto, LogAppIntentDto } from "./dto";

// `schema.WIDGET_KINDS`/`WIDGET_PRIVACY_MODES` are plain const arrays re-exported through the `schema`
// namespace (packages/db/src/index.ts's `export * as schema`) rather than flattened onto @veynlo/db's own
// root export list — so their element types are derived here rather than imported by name.
type WidgetKind = (typeof schema.WIDGET_KINDS)[number];
type WidgetPrivacyMode = (typeof schema.WIDGET_PRIVACY_MODES)[number];

/** A widget-tap deep link is short-lived — long enough for a background-refreshed widget snapshot to sit
 * on a lock screen for a while before being tapped, short enough that a leaked/cached link (a screenshot
 * of the widget, a shared photo of a locked phone) is useless within the hour. */
const DEEP_LINK_TTL_SECONDS = 60 * 60;

/** §36 SYS-001 "never a health appointment detail beyond what privacy mode allows... no raw VIN." These
 * categories carry content this app already treats as more sensitive than an ordinary inbox item
 * elsewhere (HLTH-001's non-diagnostic boundary, VEH-*'s VIN handling) — a widget tap is a lock-screen-
 * adjacent, glanceable surface, the single most exposed reading context this app has, so these categories
 * are ALWAYS shown as a generic label, never their real summary text, regardless of the per-widget privacy
 * mode setting (privacy mode only controls whether NON-sensitive items show detail or just a count). */
const ALWAYS_GENERIC_LABEL_CATEGORIES: Record<string, string> = {
  health_appointment: "A health appointment needs attention",
  identity_document: "An identity document needs attention",
  vehicle: "A vehicle item needs attention",
};

/** FIN-007 "hidden on ... widgets" — a widget tap is the same lock-screen-adjacent, most-exposed reading
 * context ALWAYS_GENERIC_LABEL_CATEGORIES above already guards; `maskAmounts` strips any dollar-shaped
 * substring an item's summary happens to carry (same `redactDollarAmounts` helper NotificationDispatchService
 * uses for identical reasonText-embedded-amount copy), on top of — never instead of — that existing gate. */
function summaryForWidget(item: { category: string; summary: string }, maskAmounts: boolean): string {
  const summary = ALWAYS_GENERIC_LABEL_CATEGORIES[item.category] ?? item.summary;
  return maskAmounts ? redactDollarAmounts(summary) : summary;
}

export interface TodaySummaryProjection {
  privacyMode: WidgetPrivacyMode;
  needsYouCount: number;
  items?: Array<{ id: string; category: string; summary: string; deepLink: string }>;
}

export interface NextTripProjection {
  privacyMode: WidgetPrivacyMode;
  hasUpcomingTrip: boolean;
  daysUntil?: number | null;
  destinationLabel?: string | null;
  deepLink?: string;
}

export interface DeliveriesProjection {
  privacyMode: WidgetPrivacyMode;
  inTransitCount: number;
  items?: Array<{ purchaseId: string | null; merchantLabel: string | null; status: string; deepLink: string | null }>;
}

/**
 * §36 SYS-001..008's shared "Backend behavior" line, built for real: "Platform bridge queries minimal
 * authorized projection APIs; caches only required snapshot; deep links use signed/internal routes; voice
 * capture enters standard source pipeline." This service is that projection layer — every method returns
 * ONLY the minimal fields a widget/App-Intent/wearable surface needs (never a full domain object), and
 * every method is privacy-mode-aware, enforced HERE server-side (never trusting a client-supplied "show me
 * detail anyway" hint — there isn't one; the only input is `userId`, resolved from the caller's own
 * session). See widgets.ts's own module doc comment for why there's no `device_projections` cache table:
 * every read here is computed fresh, which is deliberately simple and correct rather than fast-but-stale
 * at this app's current scale.
 *
 * Scoped to the requesting user's OWN objects only (no household-shared reads) — a personal lock-screen
 * widget showing another household member's items would be a real privacy regression the spec's "no
 * secrets in widget timeline/push data" line is specifically guarding against; a future family-widget
 * surface can add that as its own explicit, opt-in capability.
 */
@Injectable()
export class WidgetsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(PreferencesService) private readonly preferences: PreferencesService,
  ) {}

  // --- Preferences (SYS-001 "Privacy mode controls visible detail") ------------------------------------

  async listPreferences(userId: string): Promise<Array<{ widgetKind: WidgetKind; privacyMode: WidgetPrivacyMode; enabled: boolean }>> {
    const rows = await this.db.select().from(schema.widgetPreferences).where(eq(schema.widgetPreferences.userId, userId));
    const byKind = new Map(rows.map((r) => [r.widgetKind, r]));
    return schema.WIDGET_KINDS.map((kind) => {
      const row = byKind.get(kind);
      return { widgetKind: kind, privacyMode: (row?.privacyMode ?? "detail") as WidgetPrivacyMode, enabled: row?.enabled ?? true };
    });
  }

  async setPreference(userId: string, widgetKind: WidgetKind, dto: SetWidgetPreferenceDto): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.widgetPreferences.id })
      .from(schema.widgetPreferences)
      .where(and(eq(schema.widgetPreferences.userId, userId), eq(schema.widgetPreferences.widgetKind, widgetKind)))
      .limit(1);
    if (existing) {
      const updates: Partial<typeof schema.widgetPreferences.$inferInsert> = { updatedAt: new Date() };
      if (dto.privacyMode !== undefined) updates.privacyMode = dto.privacyMode;
      if (dto.enabled !== undefined) updates.enabled = dto.enabled;
      await this.db.update(schema.widgetPreferences).set(updates).where(eq(schema.widgetPreferences.id, existing.id));
      return;
    }
    await this.db.insert(schema.widgetPreferences).values({
      id: generateId("widgetPreference"),
      userId,
      widgetKind,
      privacyMode: dto.privacyMode ?? "detail",
      enabled: dto.enabled ?? true,
    });
  }

  private async privacyModeFor(userId: string, widgetKind: WidgetKind): Promise<WidgetPrivacyMode> {
    const [row] = await this.db
      .select({ privacyMode: schema.widgetPreferences.privacyMode })
      .from(schema.widgetPreferences)
      .where(and(eq(schema.widgetPreferences.userId, userId), eq(schema.widgetPreferences.widgetKind, widgetKind)))
      .limit(1);
    return (row?.privacyMode ?? "detail") as WidgetPrivacyMode;
  }

  // --- Projections ----------------------------------------------------------------------------------

  /** GET /v1/widgets/today-summary — SYS-001/002/006/007's "Today, Needs You count... next 1-2 items." */
  async todaySummary(userId: string): Promise<TodaySummaryProjection> {
    const privacyMode = await this.privacyModeFor(userId, "today_summary");
    const rows = await this.db
      .select({ id: schema.inboxItems.id, category: schema.inboxItems.category, summary: schema.inboxItems.summary })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, userId), eq(schema.inboxItems.reviewState, "new")))
      .orderBy(desc(schema.inboxItems.createdAt));

    if (privacyMode === "count_only") {
      return { privacyMode, needsYouCount: rows.length };
    }
    const maskAmounts = await this.preferences.isFinancialPrivacyModeEnabled(userId);
    const items = rows.slice(0, 2).map((r) => ({
      id: r.id,
      category: r.category,
      summary: summaryForWidget(r, maskAmounts),
      deepLink: createSignedDeepLink({ resourceType: "inbox_item", resourceId: r.id }, DEEP_LINK_TTL_SECONDS),
    }));
    return { privacyMode, needsYouCount: rows.length, items };
  }

  /** GET /v1/widgets/next-trip — SYS-001/002/006/007/008's "next trip" widget/live-activity surface. */
  async nextTrip(userId: string): Promise<NextTripProjection> {
    const privacyMode = await this.privacyModeFor(userId, "next_trip");
    const now = new Date();
    const [trip] = await this.db
      .select({ id: schema.trips.id, destinationLabel: schema.trips.destinationLabel, startDateSort: schema.trips.startDateSort, status: schema.trips.status })
      .from(schema.trips)
      .where(
        and(
          eq(schema.trips.ownerUserId, userId),
          or(eq(schema.trips.status, "upcoming"), eq(schema.trips.status, "active")),
          or(isNull(schema.trips.startDateSort), gte(schema.trips.startDateSort, now)),
        ),
      )
      .orderBy(schema.trips.startDateSort)
      .limit(1);

    if (!trip) return { privacyMode, hasUpcomingTrip: false };

    const daysUntil = trip.startDateSort ? Math.max(0, Math.ceil((trip.startDateSort.getTime() - now.getTime()) / 86_400_000)) : null;
    if (privacyMode === "count_only") {
      return { privacyMode, hasUpcomingTrip: true, daysUntil };
    }
    return {
      privacyMode,
      hasUpcomingTrip: true,
      daysUntil,
      destinationLabel: trip.destinationLabel,
      deepLink: createSignedDeepLink({ resourceType: "trip", resourceId: trip.id }, DEEP_LINK_TTL_SECONDS),
    };
  }

  /** GET /v1/widgets/deliveries — SYS-001/002's "deliveries" widget. Never includes a tracking number
   * (§SYS "no secrets in widget timeline/push data") even in detail mode — that field simply isn't
   * selected below, the same "schema shape is the structural layer" discipline this codebase already uses
   * elsewhere (e.g. HealthAppointmentExtractionSchema's doc comment). */
  async deliveries(userId: string): Promise<DeliveriesProjection> {
    const privacyMode = await this.privacyModeFor(userId, "deliveries");
    const rows = await this.db
      .select({
        id: schema.shipments.id,
        status: schema.shipments.status,
        purchaseId: schema.shipments.purchaseId,
        createdAt: schema.shipments.createdAt,
      })
      .from(schema.shipments)
      .where(and(eq(schema.shipments.ownerUserId, userId), ne(schema.shipments.status, "delivered")))
      .orderBy(desc(schema.shipments.createdAt));

    if (privacyMode === "count_only") {
      return { privacyMode, inTransitCount: rows.length };
    }

    const top = rows.slice(0, 2);
    const purchaseIds = top.map((r) => r.purchaseId).filter((id): id is string => Boolean(id));
    const merchantByPurchaseId = new Map<string, string | null>();
    if (purchaseIds.length > 0) {
      const purchaseRows = await this.db
        .select({ id: schema.purchases.id, merchantId: schema.purchases.merchantId })
        .from(schema.purchases)
        .where(or(...purchaseIds.map((id) => eq(schema.purchases.id, id))));
      const merchantIds = purchaseRows.map((p) => p.merchantId).filter((id): id is string => Boolean(id));
      const merchantNameById = new Map<string, string>();
      if (merchantIds.length > 0) {
        const merchantRows = await this.db
          .select({ id: schema.merchants.id, displayName: schema.merchants.displayName })
          .from(schema.merchants)
          .where(or(...merchantIds.map((id) => eq(schema.merchants.id, id))));
        for (const m of merchantRows) merchantNameById.set(m.id, m.displayName);
      }
      for (const p of purchaseRows) merchantByPurchaseId.set(p.id, p.merchantId ? (merchantNameById.get(p.merchantId) ?? null) : null);
    }

    const items = top.map((r) => ({
      purchaseId: r.purchaseId,
      merchantLabel: r.purchaseId ? (merchantByPurchaseId.get(r.purchaseId) ?? null) : null,
      status: r.status,
      deepLink: r.purchaseId ? createSignedDeepLink({ resourceType: "purchase", resourceId: r.purchaseId }, DEEP_LINK_TTL_SECONDS) : null,
    }));
    return { privacyMode, inTransitCount: rows.length, items };
  }

  // --- App Intent audit log (SYS-003/004) ------------------------------------------------------------

  async logAppIntent(userId: string, dto: LogAppIntentDto): Promise<{ id: string }> {
    const id = generateId("appIntentLog");
    await this.db.insert(schema.appIntentLog).values({
      id,
      userId,
      platform: dto.platform,
      intentKind: dto.intentKind,
      resourceType: dto.resourceType ?? null,
      resourceId: dto.resourceId ?? null,
      outcome: dto.outcome,
    });
    return { id };
  }
}
