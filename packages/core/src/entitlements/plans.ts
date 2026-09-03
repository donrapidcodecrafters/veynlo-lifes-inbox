import { z } from "zod";

/** §46.1 — product tiers. "pro_agent" is architecturally reserved, not sold at launch. */
export const PlanKeySchema = z.enum(["free", "plus", "family", "pro_agent"]);
export type PlanKey = z.infer<typeof PlanKeySchema>;

/**
 * Every gate in the product should check a capability key here, never a
 * hardcoded `plan === "plus"` string (spec §46: "centralized entitlement
 * evaluation"). Numeric quotas use `null` for "unlimited".
 */
export const CapabilityKeySchema = z.enum([
  "email_connections_max",
  "calendar_connections_max",
  "historical_backfill_days",
  "ask_queries_per_day",
  "document_storage_mb",
  "purchases_returns_tracking",
  "subscriptions_bills_tracking",
  "financial_aggregator_connections_max",
  "cloud_storage_connections_max",
  "home_vehicle_profiles",
  "family_school_sharing",
  "automation_rules_max",
  "emergency_binder",
  "data_export",
  "desktop_power_tools",
  "household_members_max",
  // Chapter 27 "Health Logistics (Non-Diagnostic)" — HLTH-001..005 are all spec'd "Entitlement: Plus/Family",
  // same tier as bills/documents tracking. Only enforced at the AI-extraction gate in
  // IngestionService.classifyAndExtract (mirroring purchases_returns_tracking/subscriptions_bills_tracking
  // exactly), not on manual creation — same posture home_vehicle_profiles already has (listed here but not
  // actually enforced on AssetsService's manual-create path either; see EntitlementsService's own doc
  // comment on which capabilities have real enforcement today).
  "health_logistics",
  // §26 "Travel & Reservations" (TRIP-001..009) — spec'd "Entitlement: Plus; premium live travel services
  // possible." Same enforcement posture as health_logistics/family_school_sharing: gated once at the
  // AI-extraction entry point (IngestionService.classifyAndExtract), not on manual trip creation (a user
  // can always hand-seed a trip — see TripsService.createManualTrip — same as home_vehicle_profiles's own
  // "listed but not enforced on the manual-create path" posture).
  "travel_planning",
  // Chapter 28 "Pets" (PET-001..005) — spec'd "Entitlement: Family" for every PET-* item, same tier and
  // enforcement posture as family_school_sharing (gated once at the AI-extraction entry point in
  // IngestionService.classifyAndExtract, not on manual pet creation — a user can always hand-add a pet via
  // PetsService.create, same "listed but not enforced on the manual-create path" posture as
  // home_vehicle_profiles).
  "pet_tracking",
  // "Identity & Legal Continuity" (ID-001..005: passport, driver's license/state ID, vehicle registration,
  // professional/recreational licenses, property/government obligations) — spec'd "Entitlement: Plus+" for
  // every ID-* item. Same enforcement posture as home_vehicle_profiles/health_logistics: listed here for
  // future gating, not currently enforced on IdentityRecordsService's manual-create path (a user can always
  // hand-add a record, same "listed but not enforced on the manual-create path" posture those two share).
  "identity_records",
]);
export type CapabilityKey = z.infer<typeof CapabilityKeySchema>;

export type CapabilityValue = number | boolean | null;

export const PLAN_CATALOG: Record<PlanKey, Record<CapabilityKey, CapabilityValue>> = {
  free: {
    email_connections_max: 1,
    calendar_connections_max: 1,
    // ONB-002 "Historical depth control" spec's own named Free-tier ceiling is "Forward only, 30 days, or
    // 90 days" (deeper options — 6 months/1 year/"build my history" — require Plus+). Previously 30, which
    // would have silently clamped a Free user's onboarding "90 days" choice down to 30 the moment they
    // picked it — this raises the actual enforced cap to match the option this tier is meant to offer,
    // rather than leaving the UI able to offer a choice the backend would quietly downgrade.
    historical_backfill_days: 90,
    ask_queries_per_day: 10,
    document_storage_mb: 250,
    purchases_returns_tracking: false,
    subscriptions_bills_tracking: false,
    financial_aggregator_connections_max: 0,
    cloud_storage_connections_max: 1,
    home_vehicle_profiles: false,
    family_school_sharing: false,
    automation_rules_max: 0,
    emergency_binder: false,
    data_export: true,
    desktop_power_tools: false,
    household_members_max: 1,
    health_logistics: false,
    travel_planning: false,
    pet_tracking: false,
    identity_records: false,
  },
  plus: {
    email_connections_max: 5,
    calendar_connections_max: 5,
    historical_backfill_days: 365,
    ask_queries_per_day: 200,
    document_storage_mb: 20_000,
    purchases_returns_tracking: true,
    subscriptions_bills_tracking: true,
    financial_aggregator_connections_max: 5,
    cloud_storage_connections_max: 5,
    home_vehicle_profiles: true,
    family_school_sharing: false,
    automation_rules_max: 20,
    emergency_binder: true,
    data_export: true,
    desktop_power_tools: true,
    household_members_max: 1,
    health_logistics: true,
    travel_planning: true,
    pet_tracking: false,
    identity_records: true,
  },
  family: {
    email_connections_max: 10,
    calendar_connections_max: 10,
    historical_backfill_days: 365,
    ask_queries_per_day: 500,
    document_storage_mb: 50_000,
    purchases_returns_tracking: true,
    subscriptions_bills_tracking: true,
    financial_aggregator_connections_max: 10,
    cloud_storage_connections_max: 10,
    home_vehicle_profiles: true,
    family_school_sharing: true,
    automation_rules_max: 50,
    emergency_binder: true,
    data_export: true,
    desktop_power_tools: true,
    household_members_max: 6,
    health_logistics: true,
    travel_planning: true,
    pet_tracking: true,
    identity_records: true,
  },
  pro_agent: {
    email_connections_max: null,
    calendar_connections_max: null,
    historical_backfill_days: null,
    ask_queries_per_day: null,
    document_storage_mb: 200_000,
    purchases_returns_tracking: true,
    subscriptions_bills_tracking: true,
    financial_aggregator_connections_max: null,
    cloud_storage_connections_max: null,
    home_vehicle_profiles: true,
    family_school_sharing: true,
    automation_rules_max: null,
    emergency_binder: true,
    data_export: true,
    desktop_power_tools: true,
    household_members_max: 10,
    health_logistics: true,
    travel_planning: true,
    pet_tracking: true,
    identity_records: true,
  },
};

export const EntitlementSourceSchema = z.enum([
  "app_store",
  "play_store",
  "web_stripe",
  "promotional",
  "referral",
  "partner_sponsored",
  "grandfathered",
  "support_granted",
]);
export type EntitlementSource = z.infer<typeof EntitlementSourceSchema>;

export const EntitlementSchema = z.object({
  id: z.string(),
  userId: z.string(),
  householdId: z.string().nullable(),
  planKey: PlanKeySchema,
  source: EntitlementSourceSchema,
  effectiveFrom: z.string().datetime(),
  effectiveTo: z.string().datetime().nullable(),
  gracePeriodEndsAt: z.string().datetime().nullable(),
  reason: z.string().nullable(), // required for promotional/grandfathered/support_granted
  createdAt: z.string().datetime(),
});
export type Entitlement = z.infer<typeof EntitlementSchema>;

/** Minimal shape `resolveCapability` needs — accepts zod-validated Entitlements or raw DB rows (Date columns) alike. */
export interface EntitlementLike {
  planKey: PlanKey;
  effectiveFrom: string | Date;
  effectiveTo: string | Date | null;
}

/** Resolves the effective capability value for a user given their current entitlement stack. */
export function resolveCapability(
  entitlements: EntitlementLike[],
  capability: CapabilityKey,
  now: Date = new Date(),
): CapabilityValue {
  const active = entitlements.filter((e) => {
    const from = new Date(e.effectiveFrom);
    const to = e.effectiveTo ? new Date(e.effectiveTo) : null;
    return from <= now && (!to || to >= now);
  });
  if (active.length === 0) return PLAN_CATALOG.free[capability];

  // Highest-value plan wins when multiple entitlements are active (e.g. household + personal grant).
  const values = active.map((e) => PLAN_CATALOG[e.planKey][capability]);
  if (values.some((v) => v === null)) return null; // unlimited wins
  if (values.some((v) => v === true)) return true;
  const numeric = values.filter((v): v is number => typeof v === "number");
  if (numeric.length > 0) return Math.max(...numeric);
  return values[0] ?? false;
}
