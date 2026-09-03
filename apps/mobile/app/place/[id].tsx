import { useCallback, useState } from "react";
import { Switch, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { refreshGeofenceRegistrations } from "@/lib/geofence-sync";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { ScreenHeader } from "@/components/screen-header";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";

interface Place {
  id: string;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

interface Geofence {
  id: string;
  placeId: string;
  radiusMeters: number;
  triggerKind: string;
  isActive: boolean;
}

interface ContextRule {
  id: string;
  geofenceId: string;
  actionKind: string;
  actionTitle: string;
  isActive: boolean;
}

const TRIGGER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "arrival", label: "Arriving" },
  { value: "departure", label: "Leaving" },
  { value: "both", label: "Both" },
];

/** LOC-001/LOC-002/LOC-003. See places.tsx's doc comment for the LOC-005 extraction this place may have come from. */
export default function PlaceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [place, setPlace] = useState<Place | null | undefined>(undefined);
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [rulesByGeofence, setRulesByGeofence] = useState<Record<string, ContextRule[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const [radius, setRadius] = useState("150");
  const [trigger, setTrigger] = useState<"arrival" | "departure" | "both">("arrival");
  const [creatingGeofence, setCreatingGeofence] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<Record<string, string>>({});
  const [creatingRuleFor, setCreatingRuleFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.get<Place[]>("/v1/places"), api.get<Geofence[]>("/v1/geofences"), api.get<ContextRule[]>("/v1/context-rules")])
      .then(async ([places, allGeofences, allRules]) => {
        const found = places.find((p) => p.id === id) ?? null;
        setPlace(found);
        const forThisPlace = allGeofences.filter((g) => g.placeId === id);
        setGeofences(forThisPlace);
        const grouped: Record<string, ContextRule[]> = {};
        for (const g of forThisPlace) grouped[g.id] = allRules.filter((r) => r.geofenceId === g.id);
        setRulesByGeofence(grouped);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this place."))
      .finally(() => setRetrying(false));
  }, [id]);

  useFocusEffect(load);

  async function handleCreateGeofence() {
    const parsedRadius = Number(radius);
    if (!Number.isFinite(parsedRadius) || parsedRadius < 20 || parsedRadius > 50_000) {
      setActionError("Enter a radius between 20 and 50,000 meters.");
      return;
    }
    setCreatingGeofence(true);
    setActionError(null);
    try {
      await api.post("/v1/geofences", { placeId: id, radiusMeters: Math.round(parsedRadius), triggerKind: trigger });
      await refreshGeofenceRegistrations();
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't create this reminder zone.");
    } finally {
      setCreatingGeofence(false);
    }
  }

  async function toggleGeofenceActive(geofence: Geofence) {
    try {
      await api.patch(`/v1/geofences/${geofence.id}`, { isActive: !geofence.isActive });
      await refreshGeofenceRegistrations();
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this reminder zone.");
    }
  }

  async function deleteGeofence(geofenceId: string) {
    try {
      await api.delete(`/v1/geofences/${geofenceId}`);
      await refreshGeofenceRegistrations();
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this reminder zone.");
    }
  }

  async function createRule(geofenceId: string) {
    const title = (ruleDraft[geofenceId] ?? "").trim();
    if (!title) return;
    setCreatingRuleFor(geofenceId);
    setActionError(null);
    try {
      await api.post("/v1/context-rules", { geofenceId, actionKind: "remind", actionTitle: title });
      setRuleDraft((prev) => ({ ...prev, [geofenceId]: "" }));
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't create this reminder.");
    } finally {
      setCreatingRuleFor(null);
    }
  }

  async function deleteRule(ruleId: string) {
    try {
      await api.delete(`/v1/context-rules/${ruleId}`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this reminder.");
    }
  }

  async function deletePlace() {
    setDeleting(true);
    try {
      await api.delete(`/v1/places/${id}`);
      await refreshGeofenceRegistrations();
      router.replace("/places");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this place.");
      setDeleting(false);
    }
  }

  // Guarded on `place === undefined` (not just `error` alone) so a refetch that fails after this screen
  // already loaded successfully once — `load` reruns on every `useFocusEffect`, e.g. navigating back into
  // this screen — doesn't blow away the already-loaded place view (the inline error Card further down
  // still surfaces that case). Mirrors trip/[id].tsx's identical guard.
  if (place === undefined && error) {
    return (
      <Screen>
        <ScreenHeader title="Place" />
        <FetchError
          message={error}
          what="this place"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }

  if (place === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Place" />
      </Screen>
    );
  }

  if (place === null) {
    return (
      <Screen>
        <ScreenHeader title="Place" />
        <EmptyState title="Not found" description="This place doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const hasCoordinates = place && place.lat != null && place.lng != null;

  return (
    <Screen>
      <ScreenHeader title={place?.label ?? "Place"} subtitle={place?.address ?? undefined} />

      {error && (
        <Card style={{ backgroundColor: theme.colors.criticalSubtleBg }}>
          <Text style={{ color: theme.colors.criticalSubtleText, fontSize: 14 }}>{error}</Text>
        </Card>
      )}
      {actionError && (
        <Card style={{ backgroundColor: theme.colors.criticalSubtleBg }}>
          <Text style={{ color: theme.colors.criticalSubtleText, fontSize: 14 }}>{actionError}</Text>
        </Card>
      )}

      <Card style={{ gap: 8 }}>
        <Badge tone={hasCoordinates ? "positive" : "neutral"}>{hasCoordinates ? "Has coordinates" : "No coordinates yet"}</Badge>
        {!hasCoordinates && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Add a latitude/longitude to this place (edit it from Saved Places) before setting up an arrival/departure reminder.
          </Text>
        )}
        <Button variant="critical" onPress={deletePlace} loading={deleting}>
          Remove this place
        </Button>
      </Card>

      {hasCoordinates && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>Add a reminder zone</Text>
          <TextField label="Radius (meters)" value={radius} onChangeText={setRadius} keyboardType="numeric" />
          <View style={{ flexDirection: "row", gap: 8 }}>
            {TRIGGER_OPTIONS.map((opt) => (
              <Button key={opt.value} variant={trigger === opt.value ? "primary" : "secondary"} onPress={() => setTrigger(opt.value as typeof trigger)}>
                {opt.label}
              </Button>
            ))}
          </View>
          <Button onPress={handleCreateGeofence} loading={creatingGeofence}>
            Create reminder zone
          </Button>
        </Card>
      )}

      {geofences.map((geofence) => (
        <Card key={geofence.id} style={{ gap: 12 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <View style={{ gap: 2 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>
                {geofence.radiusMeters}m — {TRIGGER_OPTIONS.find((o) => o.value === geofence.triggerKind)?.label ?? geofence.triggerKind}
              </Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{geofence.isActive ? "Active" : "Turned off"}</Text>
            </View>
            {/* Found live: this was the one Switch instance in the app with no trackColor/activeThumbColor
                props — every other Switch (automations.tsx, privacy/index.tsx, list/[id].tsx,
                purchase/[id].tsx's gift toggle, etc.) sets both specifically because react-native-web's
                Switch falls back to its own hardcoded teal (#009688) for the ON-state thumb/track otherwise,
                clashing with this app's brand purple. Confirmed live via getComputedStyle: this switch's ON
                track/thumb rendered rgb(163,211,207)/rgb(0,150,136) (RNW's default teal) instead of the
                brand purple every other switch uses. `activeThumbColor` isn't part of RN's typed
                SwitchProps (native ignores unknown props harmlessly) but react-native-web reads it. */}
            <Switch
              value={geofence.isActive}
              onValueChange={() => toggleGeofenceActive(geofence)}
              accessibilityLabel={`${geofence.radiusMeters}m ${TRIGGER_OPTIONS.find((o) => o.value === geofence.triggerKind)?.label ?? geofence.triggerKind} geofence`}
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>

          {(rulesByGeofence[geofence.id] ?? []).map((rule) => (
            <View key={rule.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 14, color: theme.colors.textPrimary, flex: 1 }}>{rule.actionTitle}</Text>
              <Button variant="ghost" onPress={() => deleteRule(rule.id)}>
                Remove
              </Button>
            </View>
          ))}

          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
            <View style={{ flex: 1 }}>
              <TextField
                label="Remind me to…"
                value={ruleDraft[geofence.id] ?? ""}
                onChangeText={(text) => setRuleDraft((prev) => ({ ...prev, [geofence.id]: text }))}
                placeholder="Check the sprinkler"
              />
            </View>
            <Button onPress={() => createRule(geofence.id)} loading={creatingRuleFor === geofence.id}>
              Add
            </Button>
          </View>

          <Button variant="ghost" onPress={() => deleteGeofence(geofence.id)}>
            Delete this reminder zone
          </Button>
        </Card>
      ))}
    </Screen>
  );
}
