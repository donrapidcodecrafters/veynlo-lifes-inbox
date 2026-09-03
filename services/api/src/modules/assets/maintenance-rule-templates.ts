/**
 * HOMEOS-004/VEH-003 "Maintenance engine" — a SMALL, hand-picked set of genuinely well-known, generic
 * maintenance intervals a user can add with one tap, instead of typing every interval in from scratch.
 * Deliberately NOT manufacturer-specific data (there is no free/no-key public API for a specific
 * manufacturer's actual service schedule the way NHTSA/CPSC serve recalls) — every `confidenceNote` here
 * says so explicitly, and `AssetsService.createMaintenanceRuleFromTemplate` always stamps the resulting row
 * `source: "seeded_generic_guidance"` (never `"user_added"`, and never presented as verified fact) so
 * `AttentionService`'s scan surfaces it at `confidenceBand: "approximate"`. This is intentionally a short,
 * in-code list, not a full vehicle-model/appliance-model catalog table — there's no reliable free lookup key
 * (make/model alone doesn't determine trim/engine/model-year-specific intervals) to justify one, and the
 * spec's own bar is "genuinely well-known... never presented as manufacturer-specific fact," which a small
 * curated list satisfies more honestly than a larger one that would start implying precision it doesn't have.
 */
export interface MaintenanceRuleTemplate {
  key: string;
  label: string;
  intervalType: "calendar" | "mileage" | "calendar_or_mileage";
  intervalDays?: number;
  intervalMiles?: number;
  confidenceNote: string;
}

export const VEHICLE_MAINTENANCE_TEMPLATES: MaintenanceRuleTemplate[] = [
  {
    key: "oil_change",
    label: "Oil change",
    intervalType: "calendar_or_mileage",
    intervalDays: 182,
    intervalMiles: 5000,
    confidenceNote: "General industry guidance (every 5,000–7,500 mi or 6 months, whichever comes first) — not this vehicle's manufacturer schedule. Check your owner's manual for the actual interval.",
  },
  {
    key: "tire_rotation",
    label: "Tire rotation",
    intervalType: "mileage",
    intervalMiles: 6000,
    confidenceNote: "General guidance (about every 6,000 mi) — confirm against your tire or vehicle manufacturer's own recommendation.",
  },
  {
    key: "engine_air_filter",
    label: "Engine air filter",
    intervalType: "calendar_or_mileage",
    intervalDays: 365,
    intervalMiles: 15000,
    confidenceNote: "General guidance (about every 12,000–15,000 mi or yearly) — not manufacturer-specific.",
  },
  {
    key: "cabin_air_filter",
    label: "Cabin air filter",
    intervalType: "calendar",
    intervalDays: 365,
    confidenceNote: "General guidance (about annually, sooner if airflow weakens or odors appear) — not manufacturer-specific.",
  },
  {
    key: "wiper_blades",
    label: "Wiper blades",
    intervalType: "calendar",
    intervalDays: 365,
    confidenceNote: "General guidance (about annually, sooner if streaking) — not manufacturer-specific.",
  },
  {
    key: "brake_fluid",
    label: "Brake fluid flush",
    intervalType: "calendar",
    intervalDays: 730,
    confidenceNote: "General guidance (about every 2 years) — not manufacturer-specific; check your owner's manual.",
  },
];

export const HOME_MAINTENANCE_TEMPLATES: MaintenanceRuleTemplate[] = [
  {
    key: "hvac_filter",
    label: "HVAC filter",
    intervalType: "calendar",
    intervalDays: 90,
    confidenceNote: "General guidance (every 60–90 days for a standard filter) — not manufacturer-specific; check your filter's own label for its rated life.",
  },
  {
    key: "smoke_co_detector_battery",
    label: "Smoke/CO detector battery",
    intervalType: "calendar",
    intervalDays: 365,
    confidenceNote: "General safety guidance (about annually) — not manufacturer-specific.",
  },
  {
    key: "water_heater_flush",
    label: "Water heater flush",
    intervalType: "calendar",
    intervalDays: 365,
    confidenceNote: "General guidance (about annually) — not manufacturer-specific; tank-style water heaters vary by water hardness and usage.",
  },
  {
    key: "gutter_cleaning",
    label: "Gutter cleaning",
    intervalType: "calendar",
    intervalDays: 182,
    confidenceNote: "General guidance (about twice a year — spring and fall — more often with heavy tree cover) — not property-specific.",
  },
  {
    key: "dryer_vent_cleaning",
    label: "Dryer vent cleaning",
    intervalType: "calendar",
    intervalDays: 365,
    confidenceNote: "General safety guidance (about annually) — not manufacturer-specific.",
  },
];

export function findVehicleMaintenanceTemplate(key: string): MaintenanceRuleTemplate | undefined {
  return VEHICLE_MAINTENANCE_TEMPLATES.find((t) => t.key === key);
}

export function findHomeMaintenanceTemplate(key: string): MaintenanceRuleTemplate | undefined {
  return HOME_MAINTENANCE_TEMPLATES.find((t) => t.key === key);
}
