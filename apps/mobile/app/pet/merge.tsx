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

interface PetRow {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
}

interface MergeCandidateGroup {
  reason: "matching_name_household_and_species";
  petIds: string[];
  pets: PetRow[];
}

// §40.1/40.2 "Entity Resolution" — GET /v1/pets/merge-lineage does a plain (unmapped) Drizzle join of
// pet_merge_lineage + pet_profiles, same raw-DB-table-name quirk person/merge.tsx's own doc comment
// documents for GET /v1/people/merge-lineage. `pet_profiles` below is the SURVIVING pet's row (the join
// target), used only to show "merged into X".
interface MergeLineageRow {
  pet_merge_lineage: {
    id: string;
    survivingPetId: string;
    mergedPetId: string;
    mergedPetSnapshot: { label?: string };
    actorUserId: string;
    mergedAt: string;
    unmergedAt: string | null;
  };
  pet_profiles: PetRow;
}

function petSummary(p: PetRow): string {
  const details = [p.species, p.breed].filter(Boolean).join(" · ");
  return details ? `${p.label} (${details})` : p.label;
}

/**
 * §40.2 "Entity Resolution" — pets have no spec-named merge key (§40.1's table doesn't list pets), so this
 * offers a candidate only on an exact name + household + species match (see PetsService.petMergeKey's own
 * doc comment for the reasoning), NEVER auto-merged; the user always picks which row survives. Mirrors
 * person/merge.tsx's shape exactly.
 */
export default function MergePetsScreen() {
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
    Promise.all([api.get<MergeCandidateGroup[]>("/v1/pets/merge-candidates"), api.get<MergeLineageRow[]>("/v1/pets/merge-lineage")])
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

  async function merge(survivingPetId: string, mergedPetId: string) {
    setMergingId(mergedPetId);
    setActionError(null);
    try {
      await api.post("/v1/pets/merge", { survivingPetId, mergedPetId });
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
      await api.post(`/v1/pets/merge-lineage/${lineageId}/unmerge`);
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

  const activeLineage = (lineage ?? []).filter((row) => !row.pet_merge_lineage.unmergedAt);

  return (
    <Screen>
      <ScreenHeader
        title="Possible duplicates"
        subtitle="Veynlo only offers a match on an exact name, household, and species — you always pick which one survives, and every merge can be undone."
      />

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {candidates === null && <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {candidates?.length === 0 && <EmptyState title="No duplicates found" description="Veynlo checks for an exact name, household, and species match across your pets." />}

      {candidates && candidates.length > 0 && (
        <View style={{ gap: 10 }}>
          {candidates.map((group, i) => {
            const survivorId = survivorByGroup[i] ?? group.petIds[0];
            const others = group.pets.filter((p) => p.id !== survivorId);
            return (
              <Card key={group.petIds.join(",")} style={{ gap: 8 }}>
                <Badge tone="warning">Matching name, household, and species</Badge>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Pick which one to keep:</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {group.pets.map((p) => (
                    <Pressable
                      key={p.id}
                      onPress={() => setSurvivorByGroup((prev) => ({ ...prev, [i]: p.id }))}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 999,
                        borderWidth: 1,
                        borderColor: survivorId === p.id ? theme.colors.brandDefault : theme.colors.borderSubtle,
                      }}
                    >
                      <Text style={{ fontSize: 13, color: survivorId === p.id ? theme.colors.brandDefault : theme.colors.textPrimary }}>{petSummary(p)}</Text>
                    </Pressable>
                  ))}
                </View>
                {others.map((p) => (
                  <View key={p.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Merge &quot;{p.label}&quot; into the one you kept</Text>
                    <Button variant="secondary" onPress={() => merge(survivorId, p.id)} loading={mergingId === p.id}>
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
            const mergedLabel = row.pet_merge_lineage.mergedPetSnapshot?.label ?? "A pet";
            const survivorLabel = row.pet_profiles.label;
            return (
              <Card key={row.pet_merge_lineage.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
                  &quot;{mergedLabel}&quot; was merged into &quot;{survivorLabel}&quot; on {new Date(row.pet_merge_lineage.mergedAt).toLocaleDateString()}
                </Text>
                <Button variant="secondary" onPress={() => undo(row.pet_merge_lineage.id)} loading={undoingId === row.pet_merge_lineage.id}>
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
