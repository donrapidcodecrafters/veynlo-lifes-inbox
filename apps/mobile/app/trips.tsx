import { useCallback, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { FetchError } from "@/components/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface TripRow {
  id: string;
  label: string | null;
  destinationLabel: string | null;
  startDate: TemporalValueLike | null;
  status: string;
  segmentCount: number;
  disrupted: boolean;
}

/** Mirrors apps/web's (app)/trips/page.tsx — see its own doc comment for TRIP-001. */
export default function TripsScreen() {
  const { theme } = useAppTheme();
  const [trips, setTrips] = useState<TripRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [destinationLabel, setDestinationLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    try {
      setTrips(await api.get<TripRow[]>("/v1/trips"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your trips. Please try again.");
    } finally {
      setRetrying(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function createTrip() {
    if (!destinationLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await api.post("/v1/trips", { destinationLabel });
      setDestinationLabel("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create that trip.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Trips" subtitle="Auto-assembled from your flight, lodging, rental, and ticket confirmations." />

      <Card style={{ gap: 10 }}>
        <TextField label="Start a trip" placeholder="Destination, e.g. Lisbon" value={destinationLabel} onChangeText={setDestinationLabel} />
        {/* Create-trip failures only — a failure loading the trips list in the first place is handled
            below instead (FetchError with its own Retry), not here, so it isn't shown twice. */}
        {error && trips && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
        <Button onPress={createTrip} loading={creating} disabled={!destinationLabel.trim()}>
          Create trip
        </Button>
      </Card>

      {!trips && error && (
        <FetchError
          message={error}
          what="your trips"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      )}
      {!trips && !error && (
        <View style={{ gap: 8 }}>
          <View style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
        </View>
      )}

      {trips?.length === 0 && (
        <EmptyState title="No trips yet" description="Trips appear automatically once a flight, hotel, rental, or ticket confirmation arrives — or create one above." />
      )}

      {trips && trips.length > 0 && (
        <View style={{ gap: 8 }}>
          {trips.map((trip) => (
            <Pressable accessibilityRole="button" key={trip.id} onPress={() => router.push(`/trip/${trip.id}`)}>
              <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{trip.label ?? trip.destinationLabel ?? "Trip"}</Text>
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                    {trip.destinationLabel && <Badge tone="neutral">{trip.destinationLabel}</Badge>}
                    <Badge tone={trip.status === "cancelled" ? "critical" : "neutral"}>{trip.status}</Badge>
                    {trip.disrupted && <Badge tone="critical">Disruption</Badge>}
                  </View>
                </View>
                <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{formatTemporal(trip.startDate) ?? "Dates TBD"}</Text>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}
