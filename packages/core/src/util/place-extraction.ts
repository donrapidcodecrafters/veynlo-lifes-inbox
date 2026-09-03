/**
 * LOC-005 "Place from capture" — "Resolve shared map link/address/photo metadata into Place candidate."
 * Best-effort, deliberately conservative extraction from a captured/shared text string (a shared map
 * link, a pasted address, a message body). Recognizes:
 *   1. A maps-link URL with embedded coordinates (Google Maps `@lat,lng`/`q=lat,lng`, Apple Maps
 *      `ll=lat,lng`) — returns real coordinates, no network call.
 *   2. A plain street-address-shaped string — returns the address text with NO coordinates.
 *
 * Deliberately does NOT call a geocoding API to resolve a bare business name ("Starbucks on 5th") or a
 * street address into coordinates — that needs a paid geocoding provider (Google Geocoding API, Mapbox,
 * etc.), none of which is configured in this dev environment (see docs/PHASE3_PENDING_CREDENTIALS.md). A
 * bare business name with no coordinates and no parseable address returns `null` — never a fabricated
 * location. Photo EXIF GPS metadata (the third source LOC-005 names) is a mobile-only, device-local
 * capability with no representation in captured text at all — out of scope for this pure text function;
 * see the mobile capture screen's own notes on why it isn't wired up either (no EXIF-reading dependency
 * exists anywhere in this codebase).
 */

export type PlaceCandidateSource = "extracted_maps_link" | "extracted_address";

export interface PlaceCandidate {
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: PlaceCandidateSource;
}

// Ordered most-specific first: a generic "@lat,lng" pattern (present in most Google Maps share links,
// but which could in principle appear in unrelated text) is checked only after the more distinctive
// query-param forms.
const GOOGLE_MAPS_QUERY_RE = /[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/i;
const APPLE_MAPS_LL_RE = /[?&]ll=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/i;
const GOOGLE_MAPS_AT_RE = /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/;

// A conservative US-style street address: a leading number, a short run of words, a common street-type
// suffix, then a city/state/zip. Intentionally narrow — missing a real address (false negative) is far
// safer here than fabricating a Place from an unrelated number (false positive).
const STREET_ADDRESS_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Cir|Circle|Ter|Terrace)\.?,?\s+[A-Za-z .'-]{2,40},?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;

function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function extractMapsLinkCoordinates(text: string): LatLngMatch | null {
  for (const re of [GOOGLE_MAPS_QUERY_RE, APPLE_MAPS_LL_RE, GOOGLE_MAPS_AT_RE]) {
    const m = text.match(re);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }
  return null;
}

interface LatLngMatch {
  lat: number;
  lng: number;
}

/**
 * Returns one candidate at most (no disambiguation among several map links/addresses found in the same
 * text — the spec's "disambiguation asks user when multiple businesses/locations match" applies to a
 * real geocoder returning several business matches for one query, which this function, having no
 * geocoder, cannot produce; a caller station wanting multiple candidates from one text blob would need
 * to call this repeatedly against progressively trimmed input, not something built here since nothing in
 * this codebase needs it yet). Prefers a maps-link coordinate match over a plain address match when a
 * text contains both, since coordinates are exact and an address in the same message is often just the
 * human-readable label for that same link.
 */
export function extractPlaceCandidate(text: string): PlaceCandidate | null {
  if (!text || !text.trim()) return null;

  const coords = extractMapsLinkCoordinates(text);
  if (coords) {
    return { address: null, lat: coords.lat, lng: coords.lng, source: "extracted_maps_link" };
  }

  const addressMatch = text.match(STREET_ADDRESS_RE);
  if (addressMatch) {
    return { address: addressMatch[0].trim(), lat: null, lng: null, source: "extracted_address" };
  }

  return null;
}
