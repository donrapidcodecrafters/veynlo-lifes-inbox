/**
 * LOC-004 "Travel-time conflict" — this dev environment has no live distance/maps provider API key
 * configured (no `MAPS_PROVIDER_API_KEY`, no Google Distance Matrix or equivalent credential — see
 * docs/PHASE3_PENDING_CREDENTIALS.md). Rather than fabricate a fake travel-time estimate or hardcode a
 * fake provider, this computes a straight-line (haversine) distance between two points and converts it
 * to a rough time estimate using one flat average-speed assumption.
 *
 * This is explicitly NOT traffic-aware and NOT routing-aware — it ignores roads, one-way streets, water,
 * mountains, everything. It can be dramatically wrong for some geographies (two points a mile apart
 * across a bay with no bridge, for instance). Spec LOC-004 requires: "Show estimate and uncertainty; do
 * not continuously track actual movement." A haversine estimate satisfies "show an estimate" only when
 * its roughness is disclosed, never hidden — every caller MUST surface `uncertaintyNote` (or equivalent
 * wording) next to `estimatedMinutes`, never the number alone. `method` is always
 * `"haversine_rough_estimate"`, never something that could be confused with a real provider's output.
 */

const EARTH_RADIUS_METERS = 6_371_000;

// A single flat assumption meant to cover a realistic mix of surface-street and highway driving.
// Deliberately not mode-aware (walking/transit/driving) — a Place record carries no signal to pick a
// mode from, and inventing one would add false precision on top of an already-rough estimate.
const ASSUMED_AVERAGE_SPEED_KMH = 40;

export const TRAVEL_ESTIMATE_UNCERTAINTY_NOTE =
  "Rough straight-line estimate, not real traffic-aware travel time — actual travel time may be significantly longer depending on roads and traffic.";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface HaversineTravelEstimate {
  distanceMeters: number;
  estimatedMinutes: number;
  method: "haversine_rough_estimate";
  uncertaintyNote: string;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle ("as the crow flies") distance between two points, in meters. */
export function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METERS * c;
}

export function estimateTravelTime(a: LatLng, b: LatLng): HaversineTravelEstimate {
  const distanceMeters = haversineDistanceMeters(a, b);
  const hours = distanceMeters / 1000 / ASSUMED_AVERAGE_SPEED_KMH;
  const estimatedMinutes = Math.max(1, Math.round(hours * 60));
  return {
    distanceMeters: Math.round(distanceMeters),
    estimatedMinutes,
    method: "haversine_rough_estimate",
    uncertaintyNote: TRAVEL_ESTIMATE_UNCERTAINTY_NOTE,
  };
}
