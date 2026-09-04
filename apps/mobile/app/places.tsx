import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { getPermissionSnapshot } from "@/lib/geofencing";
import type { LocationPermissionSnapshot } from "@/lib/geofencing.types";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { FetchError } from "@/components/fetch-error";

interface Place {
  id: string;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: string;
}

interface PlaceCandidate {
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: "extracted_maps_link" | "extracted_address";
}

/**
 * LOC-001 "Saved places" (Core-tier — no location permission required to use this screen at all: places
 * can be entered manually with just a label/address). LOC-005 "Place from capture" is the "Paste a link or
 * address" box below, which only ever parses text locally server-side (no geocoding API call — see
 * packages/core/src/util/place-extraction.ts's doc comment) and always shows the parsed result for the
 * user to confirm before saving, never auto-saves.
 */
export default function PlacesScreen() {
  const { theme } = useAppTheme();
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [permission, setPermission] = useState<LocationPermissionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [candidate, setCandidate] = useState<PlaceCandidate | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .get<Place[]>("/v1/places")
      .then(setPlaces)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your saved places."))
      .finally(() => setRetrying(false));
    getPermissionSnapshot()
      .then(setPermission)
      .catch(() => setPermission(null));
  }, []);

  useFocusEffect(load);

  async function handleExtract() {
    if (!pasteText.trim()) return;
    setExtracting(true);
    setFormError(null);
    try {
      const { candidate: found } = await api.post<{ candidate: PlaceCandidate | null }>("/v1/places/extract", { text: pasteText });
      setCandidate(found);
      if (found) {
        setAddress(found.address ?? "");
        setLat(found.lat != null ? String(found.lat) : "");
        setLng(found.lng != null ? String(found.lng) : "");
        if (!label.trim()) setLabel(found.source === "extracted_maps_link" ? "New place" : found.address ?? "New place");
      } else {
        setFormError("Couldn't find a map link or address in that text — enter the place manually below.");
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Couldn't parse that text.");
    } finally {
      setExtracting(false);
    }
  }

  async function handleSave() {
    if (!label.trim()) {
      setFormError("Give this place a name.");
      return;
    }
    const trimmedLat = lat.trim();
    const trimmedLng = lng.trim();
    if (Boolean(trimmedLat) !== Boolean(trimmedLng)) {
      setFormError("Enter both a latitude and a longitude, or leave both blank.");
      return;
    }
    let parsedLat: number | null = null;
    let parsedLng: number | null = null;
    if (trimmedLat && trimmedLng) {
      parsedLat = Number(trimmedLat);
      parsedLng = Number(trimmedLng);
      if (Number.isNaN(parsedLat) || Number.isNaN(parsedLng) || Math.abs(parsedLat) > 90 || Math.abs(parsedLng) > 180) {
        setFormError("Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
        return;
      }
    }
    setSaving(true);
    setFormError(null);
    try {
      await api.post("/v1/places", { label: label.trim(), address: address.trim() || null, lat: parsedLat, lng: parsedLng });
      setLabel("");
      setPasteText("");
      setAddress("");
      setLat("");
      setLng("");
      setCandidate(null);
      setShowForm(false);
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Couldn't save this place.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Saved places" subtitle="Home, work, family, or anywhere you want a reminder for" />

      <Card style={{ gap: 8 }}>
        {/* `flexWrap` matters here: the worst-case badge string is "undetermined / background undetermined",
            which is far too wide to sit beside the label on a phone. Badge is deliberately a single-line pill
            (see its own comment), so the row has to reflow instead — otherwise the badge is clipped off the
            right edge of the screen, which is what happened before. */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>Location permission</Text>
          <Badge tone={permission?.foreground === "granted" ? "positive" : "neutral"}>
            {permission ? `${permission.foreground} / background ${permission.background}` : "unknown"}
          </Badge>
        </View>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Arrival/departure reminders need location permission. Places work fine without it — you just won&apos;t get automatic
          reminders.
        </Text>
        <Button variant="secondary" onPress={() => router.push("/location-permissions")}>
          Manage location permission
        </Button>
      </Card>

      {/* A failure loading the places list in the first place is handled below instead (FetchError with
          its own Retry, since this screen has no pull-to-refresh); this banner is for a background reload
          — e.g. after saving a new place — that fails once the list is already showing. */}
      {error && places && (
        <Card style={{ backgroundColor: theme.colors.criticalSubtleBg }}>
          <Text style={{ color: theme.colors.criticalSubtleText, fontSize: 14 }}>{error}</Text>
        </Card>
      )}

      {!showForm && <Button onPress={() => setShowForm(true)}>+ Add a place</Button>}

      {showForm && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>New place</Text>
          <TextField
            label="Paste a shared map link or address (optional)"
            value={pasteText}
            onChangeText={setPasteText}
            placeholder="https://maps.google.com/... or 1600 Amphitheatre Pkwy, Mountain View, CA 94043"
            multiline
          />
          <Button variant="secondary" onPress={handleExtract} loading={extracting}>
            Parse text
          </Button>
          {candidate && (
            <Text style={{ fontSize: 13, color: theme.colors.positiveSubtleText }}>
              {candidate.source === "extracted_maps_link" ? "Found coordinates from a map link." : "Found an address (no coordinates yet)."}
            </Text>
          )}
          <TextField label="Name" value={label} onChangeText={setLabel} placeholder="e.g. Home, Mom's house, Costco" />
          <TextField label="Address (optional)" value={address} onChangeText={setAddress} placeholder="Street, city, state, zip" />
          <View style={{ flexDirection: "row", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <TextField label="Latitude (optional)" value={lat} onChangeText={setLat} keyboardType="numeric" placeholder="37.7749" />
            </View>
            <View style={{ flex: 1 }}>
              <TextField label="Longitude (optional)" value={lng} onChangeText={setLng} keyboardType="numeric" placeholder="-122.4194" />
            </View>
          </View>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Coordinates are needed only if you want an arrival/departure reminder for this place.
          </Text>
          {formError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{formError}</Text>}
          <View style={{ flexDirection: "row", gap: 12 }}>
            <Button onPress={handleSave} loading={saving}>
              Save place
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                setShowForm(false);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
          </View>
        </Card>
      )}

      {places === null && error && (
        <FetchError
          message={error}
          what="your saved places"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      )}
      {places === null && !error && <View style={{ height: 80 }} />}
      {places && places.length === 0 && (
        <EmptyState title="No saved places yet" description="Add a home, family member's address, or store to set up an arrival reminder." />
      )}
      {places && places.length > 0 && (
        <View style={{ gap: 8 }}>
          {places.map((place) => (
            <Pressable accessibilityRole="button" key={place.id} onPress={() => router.push(`/place/${place.id}`)}>
              <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View style={{ gap: 2, flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{place.label}</Text>
                  {place.address && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{place.address}</Text>}
                </View>
                <Badge tone={place.lat != null ? "positive" : "neutral"}>{place.lat != null ? "Has coordinates" : "No coordinates"}</Badge>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}
