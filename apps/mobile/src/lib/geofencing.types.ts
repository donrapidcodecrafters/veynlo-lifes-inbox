export type LocationPermissionStatus = "granted" | "denied" | "undetermined";

export interface LocationPermissionSnapshot {
  foreground: LocationPermissionStatus;
  background: LocationPermissionStatus;
  /** "precise" | "approximate" | "unknown" — unknown when foreground isn't granted yet. */
  precision: "precise" | "approximate" | "unknown";
}

export interface GeofenceDefinition {
  /** Veynlo's own geofence id — reused directly as the OS region identifier, see geofencing.native.ts. */
  id: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  /** "arrival" | "departure" | "both" — controls which OS notify flags are set for this region. */
  triggerKind: string;
}

export interface RegisterGeofencesResult {
  ok: boolean;
  error?: string;
}
