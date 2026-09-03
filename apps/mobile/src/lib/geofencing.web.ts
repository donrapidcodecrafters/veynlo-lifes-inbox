import type { GeofenceDefinition, LocationPermissionSnapshot, RegisterGeofencesResult } from "./geofencing.types";

/**
 * Web stub — resolved by Metro instead of `geofencing.native.ts` under `expo start --web` (this app's
 * Expo web preview). Same reasoning as `plaid-link.web.ts`: `expo-location`/`expo-task-manager` are
 * native-only Expo Modules, and OS-level geofencing (`Location.startGeofencingAsync`,
 * `TaskManager.defineTask`) has no meaningful browser equivalent — a browser can request one-shot/
 * watched foreground geolocation, but nothing resembling background region monitoring that survives the
 * app being closed. Rather than fake a "geofencing available" state in a browser preview, every function
 * here reports unavailable/undetermined so the Saved Places screen can render its permission and CRUD UI
 * without crashing (verified via Playwright), while the real native flow is only ever exercised on-device.
 */
export const geofencingAvailable = false;

export async function requestForegroundPermission(): Promise<LocationPermissionSnapshot> {
  return { foreground: "undetermined", background: "undetermined", precision: "unknown" };
}

export async function requestBackgroundPermission(): Promise<LocationPermissionSnapshot> {
  return { foreground: "undetermined", background: "undetermined", precision: "unknown" };
}

export async function getPermissionSnapshot(): Promise<LocationPermissionSnapshot> {
  return { foreground: "undetermined", background: "undetermined", precision: "unknown" };
}

export async function syncGeofenceRegistrations(_active: GeofenceDefinition[]): Promise<RegisterGeofencesResult> {
  return { ok: false, error: "Background location geofencing isn't available in this preview — use the installed app." };
}

export async function stopAllGeofencing(): Promise<void> {}
