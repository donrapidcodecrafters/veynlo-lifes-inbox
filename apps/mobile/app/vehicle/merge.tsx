import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { ScreenHeader } from "@/components/screen-header";

interface VehicleRow {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number | null;
}

interface MergeCandidateGroup {
  reason: "matching_vin";
  vehicleIds: string[];
  vehicles: VehicleRow[];
}

// §40.1/40.2 "Entity Resolution" — GET /v1/vehicles/merge-lineage does a plain (unmapped) Drizzle join of
// vehicle_merge_lineage + vehicle_profiles, so the JSON keys back are the raw DB table names, same quirk
// person/merge.tsx's own doc comment documents for GET /v1/people/merge-lineage. `vehicle_profiles` below
// is the SURVIVING vehicle's row (the join target), used only to show "merged into X".
interface MergeLineageRow {
  vehicle_merge_lineage: {
    id: string;
    survivingVehicleId: string;
    mergedVehicleId: string;
    mergedVehicleSnapshot: { label?: string };
    actorUserId: string;
    mergedAt: string;
    unmergedAt: string | null;
  };
  vehicle_profiles: VehicleRow;
}

function vehicleSummary(v: VehicleRow): string {
  const details = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return details ? `${v.label} (${details})` : v.label;
}

/**
 * §40.1 "Vehicle: VIN [is the] auto-merge standard ... otherwise user confirmation for potentially distinct
 * vehicles" — precision-first: the only candidate signal is an exact VIN match, NEVER auto-merged; the user
 * always picks which row survives. Mirrors person/merge.tsx's shape exactly.
 */
export default function MergeVehiclesScreen() {
  const { theme } = useAppTheme();
  const [candidates, setCandidates] = useState<MergeCandidateGroup[] | null>(null);
  const [lineage, setLineage] = useState<MergeLineageRow[] | null>(null);
  const [survivorByGroup, setSurvivorByGroup] = useState<Record<number, string>>({});
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.get<MergeCandidateGroup[]>("/v1/vehicles/merge-candidates"), api.get<MergeLineageRow[]>("/v1/vehicles/merge-lineage")])
      .then(([c, l]) => {
        setCandidates(c);
        setLineage(l);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again.");
      })
      .finally(() => setRetrying(false));
  }, []);

  useFocusEffect(load);

  async function merge(survivingVehicleId: string, mergedVehicleId: string) {
    setMergingId(mergedVehicleId);
    setActionError(null);
    try {
      await api.post("/v1/vehicles/merge", { survivingVehicleId, mergedVehicleId });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't merge these. Please try again.");
    } finally {
      setMergingId(null);
    }
  }

  async function undo(lineageId: string) {
    setUndoingId(lineageId);
    setActionError(null);
    try {
      await api.post(`/v1/vehicles/merge-lineage/${lineageId}/unmerge`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't undo this merge. Please try again.");
    } finally {
      setUndoingId(null);
    }
  }

  if (error && candidates === null) {
    return (
      <Screen>
        <ScreenHeader title="Possible duplicates" />
        <FetchError
          message={error}
          what="possible duplicates"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }

  const activeLineage = (lineage ?? []).filter((row) => !row.vehicle_merge_lineage.unmergedAt);

  return (
    <Screen>
      <ScreenHeader title="Possible duplicates" subtitle="Veynlo only offers a match on an exact VIN — you always pick which one survives, and every merge can be undone." />

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {candidates === null && <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {candidates?.length === 0 && <EmptyState title="No duplicates found" description="Veynlo checks for an exact VIN match across your vehicles." />}

      {candidates && candidates.length > 0 && (
        <View style={{ gap: 10 }}>
          {candidates.map((group, i) => {
            const survivorId = survivorByGroup[i] ?? group.vehicleIds[0];
            const others = group.vehicles.filter((v) => v.id !== survivorId);
            return (
              <Card key={group.vehicleIds.join(",")} style={{ gap: 8 }}>
                <Badge tone="warning">Matching VIN</Badge>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Pick which one to keep:</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {group.vehicles.map((v) => (
                    <Pressable
                      key={v.id}
                      onPress={() => setSurvivorByGroup((prev) => ({ ...prev, [i]: v.id }))}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: survivorId === v.id ? theme.colors.brandDefault : theme.colors.borderSubtle,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: survivorId === v.id ? theme.colors.brandDefault : theme.colors.textPrimary }}>{vehicleSummary(v)}</Text>
                    </Pressable>
                  ))}
                </View>
                {others.map((v) => (
                  <View key={v.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Merge &quot;{v.label}&quot; into the one you kept</Text>
                    <Button variant="secondary" onPress={() => merge(survivorId, v.id)} loading={mergingId === v.id}>
                      Merge
                    </Button>
                  </View>
                ))}
              </Card>
            );
          })}
        </View>
      )}

      {activeLineage.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Past merges</Text>
          {activeLineage.map((row) => {
            const mergedLabel = row.vehicle_merge_lineage.mergedVehicleSnapshot?.label ?? "A vehicle";
            const survivorLabel = row.vehicle_profiles.label;
            return (
              <Card key={row.vehicle_merge_lineage.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
                  &quot;{mergedLabel}&quot; was merged into &quot;{survivorLabel}&quot; on {new Date(row.vehicle_merge_lineage.mergedAt).toLocaleDateString()}
                </Text>
                <Button variant="secondary" onPress={() => undo(row.vehicle_merge_lineage.id)} loading={undoingId === row.vehicle_merge_lineage.id}>
                  Undo
                </Button>
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}
