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
  "home_vehicle_profiles",
  "family_school_sharing",
  "automation_rules_max",
  "emergency_binder",
  "data_export",
  "desktop_power_tools",
  "household_members_max",
]);
export type CapabilityKey = z.infer<typeof CapabilityKeySchema>;

export type CapabilityValue = number | boolean | null;

export const PLAN_CATALOG: Record<PlanKey, Record<CapabilityKey, CapabilityValue>> = {
  free: {
    email_connections_max: 1,
    calendar_connections_max: 1,
    historical_backfill_days: 30,
    ask_queries_per_day: 10,
    document_storage_mb: 250,
    purchases_returns_tracking: false,
    subscriptions_bills_tracking: false,
    financial_aggregator_connections_max: 0,
    home_vehicle_profiles: false,
    family_school_sharing: false,
    automation_rules_max: 0,
    emergency_binder: false,
    data_export: true,
    desktop_power_tools: false,
    household_members_max: 1,
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
    home_vehicle_profiles: true,
    family_school_sharing: false,
    automation_rules_max: 20,
    emergency_binder: true,
    data_export: true,
    desktop_power_tools: true,
    household_members_max: 1,
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
    home_vehicle_profiles: true,
    family_school_sharing: true,
    automation_rules_max: 50,
    emergency_binder: true,
    data_export: true,
    desktop_power_tools: true,
    household_members_max: 6,
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
    home_vehicle_profiles: true,
    family_school_sharing: true,
    automation_rules_max: null,
    emergency_binder: true,
    data_export: true,
    desktop_power_tools: true,
    household_members_max: 10,
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
