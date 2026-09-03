import { api } from "./api-client";
import { syncGeofenceRegistrations } from "./geofencing";
import type { GeofenceDefinition } from "./geofencing.types";

interface PlaceRow {
  id: string;
  lat: number | null;
  lng: number | null;
}

interface GeofenceRow {
  id: string;
  placeId: string;
  radiusMeters: number;
  triggerKind: string;
  isActive: boolean;
}

/**
 * Re-registers the full set of the current user's active, coordinate-backed geofences with the OS
 * (`Location.startGeofencingAsync` replaces the whole region set per call — see geofencing.native.ts) —
 * call this after any create/update/delete that could change which geofences should be actively
 * monitored. Best-effort: a sync failure (permission not granted, unavailable in this preview) is
 * swallowed here since the Saved Places / place detail screens already surface permission status
 * separately, and a failed background-registration sync shouldn't block the CRUD action that triggered it.
 */
export async function refreshGeofenceRegistrations(): Promise<void> {
  try {
    const [places, geofences] = await Promise.all([api.get<PlaceRow[]>("/v1/places"), api.get<GeofenceRow[]>("/v1/geofences")]);
    const placesById = new Map(places.map((p) => [p.id, p]));
    const active: GeofenceDefinition[] = geofences
      .filter((g) => g.isActive)
      .map((g) => {
        const place = placesById.get(g.placeId);
        if (!place || place.lat == null || place.lng == null) return null;
        return { id: g.id, lat: place.lat, lng: place.lng, radiusMeters: g.radiusMeters, triggerKind: g.triggerKind };
      })
      .filter((g): g is GeofenceDefinition => g !== null);
    await syncGeofenceRegistrations(active);
  } catch {
    // Best-effort — see doc comment above.
  }
}
