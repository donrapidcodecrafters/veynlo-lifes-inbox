import { Platform } from "react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { api } from "./api-client";
import type { GeofenceDefinition, LocationPermissionSnapshot, LocationPermissionStatus, RegisterGeofencesResult } from "./geofencing.types";

export const geofencingAvailable = true;

const GEOFENCE_TASK_NAME = "veynlo-geofence-task";

/**
 * §30.1 "prefer OS geofencing/significant-change mechanisms over continuous background tracking." This is
 * the concrete mechanism: `defineTask` is registered once, at module load (an Expo/React Native
 * requirement — the OS needs to be able to relaunch the app in the background and immediately find a task
 * of this exact name, even if the app process was fully killed, which is why this call lives at module
 * scope rather than inside a component or hook). The OS calls this task ONLY when a device actually
 * crosses a region boundary this app registered via `syncGeofenceRegistrations` below — there is no
 * polling loop, no interval timer, and no code anywhere in this file that reads or stores a raw device
 * position. The region's own `identifier` is set to Veynlo's own geofence id when it's registered (see
 * `toLocationRegion` below), so this handler can report the event straight back to
 * `POST /v1/geofence-events` with no on-device lookup table to keep in sync.
 *
 * UNVERIFIED ON A REAL DEVICE: this environment cannot run `expo prebuild` + Xcode/Gradle (same
 * limitation as this session's other native-only additions — see docs/PHASE2_PENDING_CREDENTIALS.md's
 * Plaid Link/share-intent entries and docs/PHASE3_PENDING_CREDENTIALS.md). This code is typechecked and
 * follows expo-location's documented API exactly, but the actual "OS wakes the killed app and this task
 * fires" behavior has never been exercised end to end.
 */
TaskManager.defineTask(GEOFENCE_TASK_NAME, async ({ data, error }) => {
  if (error) {
    console.warn("[geofencing] task error:", error.message);
    return;
  }
  const payload = data as { eventType?: Location.LocationGeofencingEventType; region?: Location.LocationRegion } | undefined;
  const identifier = payload?.region?.identifier;
  if (!identifier || payload?.eventType == null) return;
  const triggerKind = payload.eventType === Location.GeofencingEventType.Enter ? "arrival" : "departure";
  try {
    await api.post("/v1/geofence-events", { geofenceId: identifier, triggerKind });
  } catch (err) {
    // Best-effort — a transient network failure while the app is backgrounded shouldn't crash the task
    // (there is no user-facing surface to show an error to at this point; the reminder simply doesn't
    // fire this once). Matches this codebase's established "log and swallow" stance for background sync
    // failures elsewhere (e.g. IngestionService's connector sync error handling).
    console.warn("[geofencing] failed to report event:", (err as Error).message);
  }
});

function toPermissionStatus(status: string | undefined): LocationPermissionStatus {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  return "undetermined";
}

function extractPrecision(response: Location.LocationPermissionResponse): "precise" | "approximate" | "unknown" {
  if (!response.granted) return "unknown";
  if (Platform.OS === "ios" && response.ios) return response.ios.accuracy === "reduced" ? "approximate" : "precise";
  if (Platform.OS === "android" && response.android) return response.android.accuracy === "coarse" ? "approximate" : "precise";
  return "precise";
}

export async function getPermissionSnapshot(): Promise<LocationPermissionSnapshot> {
  const foreground = await Location.getForegroundPermissionsAsync();
  const background = await Location.getBackgroundPermissionsAsync();
  return {
    foreground: toPermissionStatus(foreground.status),
    background: toPermissionStatus(background.status),
    precision: extractPrecision(foreground),
  };
}

/** Step 1 of the consent flow — must be granted (and explained) before background is ever requested. */
export async function requestForegroundPermission(): Promise<LocationPermissionSnapshot> {
  const foreground = await Location.requestForegroundPermissionsAsync();
  const background = await Location.getBackgroundPermissionsAsync();
  return {
    foreground: toPermissionStatus(foreground.status),
    background: toPermissionStatus(background.status),
    precision: extractPrecision(foreground),
  };
}

/** Step 2 — only meaningful, and only ever prompted, after foreground is already granted (both OS
 * platforms require this ordering; requesting background first either no-ops or errors). */
export async function requestBackgroundPermission(): Promise<LocationPermissionSnapshot> {
  const background = await Location.requestBackgroundPermissionsAsync();
  const foreground = await Location.getForegroundPermissionsAsync();
  return {
    foreground: toPermissionStatus(foreground.status),
    background: toPermissionStatus(background.status),
    precision: extractPrecision(foreground),
  };
}

function toLocationRegion(g: GeofenceDefinition): Location.LocationRegion {
  return {
    identifier: g.id,
    latitude: g.lat,
    longitude: g.lng,
    radius: g.radiusMeters,
    notifyOnEnter: g.triggerKind === "arrival" || g.triggerKind === "both",
    notifyOnExit: g.triggerKind === "departure" || g.triggerKind === "both",
  };
}

/**
 * `startGeofencingAsync` replaces the ENTIRE region set for this task name on each call (it is not
 * additive) — so this always re-registers the full list of the user's currently-active geofences, never
 * a single one. Called after permissions are confirmed granted and whenever the user's set of active
 * geofences changes (created, deleted, toggled off). An empty `active` array stops geofencing entirely
 * rather than calling `startGeofencingAsync` with zero regions (documented as unsupported/undefined
 * behavior by the OS-level geofencing APIs this wraps).
 */
export async function syncGeofenceRegistrations(active: GeofenceDefinition[]): Promise<RegisterGeofencesResult> {
  try {
    if (active.length === 0) {
      if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME)) {
        await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
      }
      return { ok: true };
    }
    await Location.startGeofencingAsync(GEOFENCE_TASK_NAME, active.map(toLocationRegion));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function stopAllGeofencing(): Promise<void> {
  if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK_NAME)) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK_NAME);
  }
}
