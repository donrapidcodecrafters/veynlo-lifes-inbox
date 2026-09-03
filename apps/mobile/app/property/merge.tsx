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

interface PropertyRow {
  id: string;
  label: string;
  address: string | null;
  propertyType: string;
}

interface MergeCandidateGroup {
  reason: "matching_address";
  propertyIds: string[];
  properties: PropertyRow[];
}

// §40.1/40.2 "Entity Resolution" — GET /v1/properties/merge-lineage does a plain (unmapped) Drizzle join of
// property_merge_lineage + property_profiles, same raw-DB-table-name quirk person/merge.tsx's own doc
// comment documents for GET /v1/people/merge-lineage. `property_profiles` below is the SURVIVING property's
// row (the join target), used only to show "merged into X".
interface MergeLineageRow {
  property_merge_lineage: {
    id: string;
    survivingPropertyId: string;
    mergedPropertyId: string;
    mergedPropertySnapshot: { label?: string };
    actorUserId: string;
    mergedAt: string;
    unmergedAt: string | null;
  };
  property_profiles: PropertyRow;
}

function propertySummary(p: PropertyRow): string {
  return p.address ? `${p.label} (${p.address})` : p.label;
}

/**
 * §40.1 "Property: normalized full address + user property identity ... User confirmation when unit/parcel
 * ambiguity exists" — precision-first: the only candidate signal is an exact normalized-address match,
 * NEVER auto-merged; the user always picks which row survives. Mirrors person/merge.tsx's shape exactly.
 */
export default function MergePropertiesScreen() {
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
    Promise.all([api.get<MergeCandidateGroup[]>("/v1/properties/merge-candidates"), api.get<MergeLineageRow[]>("/v1/properties/merge-lineage")])
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

  async function merge(survivingPropertyId: string, mergedPropertyId: string) {
    setMergingId(mergedPropertyId);
    setActionError(null);
    try {
      await api.post("/v1/properties/merge", { survivingPropertyId, mergedPropertyId });
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
      await api.post(`/v1/properties/merge-lineage/${lineageId}/unmerge`);
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

  const activeLineage = (lineage ?? []).filter((row) => !row.property_merge_lineage.unmergedAt);

  return (
    <Screen>
      <ScreenHeader
        title="Possible duplicates"
        subtitle="Veynlo only offers a match on an exact normalized address — you always pick which one survives, and every merge can be undone."
      />

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {candidates === null && <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {candidates?.length === 0 && <EmptyState title="No duplicates found" description="Veynlo checks for an exact normalized address match across your properties." />}

      {candidates && candidates.length > 0 && (
        <View style={{ gap: 10 }}>
          {candidates.map((group, i) => {
            const survivorId = survivorByGroup[i] ?? group.propertyIds[0];
            const others = group.properties.filter((p) => p.id !== survivorId);
            return (
              <Card key={group.propertyIds.join(",")} style={{ gap: 8 }}>
                <Badge tone="warning">Matching address</Badge>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Pick which one to keep:</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {group.properties.map((p) => (
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
                      <Text style={{ fontSize: 13, color: survivorId === p.id ? theme.colors.brandDefault : theme.colors.textPrimary }}>{propertySummary(p)}</Text>
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
            const mergedLabel = row.property_merge_lineage.mergedPropertySnapshot?.label ?? "A property";
            const survivorLabel = row.property_profiles.label;
            return (
              <Card key={row.property_merge_lineage.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
                  &quot;{mergedLabel}&quot; was merged into &quot;{survivorLabel}&quot; on {new Date(row.property_merge_lineage.mergedAt).toLocaleDateString()}
                </Text>
                <Button variant="secondary" onPress={() => undo(row.property_merge_lineage.id)} loading={undoingId === row.property_merge_lineage.id}>
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
