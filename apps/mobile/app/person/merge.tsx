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
import { mergeReasonText } from "@/lib/people";

interface PersonRow {
  id: string;
  displayName: string;
}

interface MergeCandidateGroup {
  reason: "matching_email" | "matching_phone" | "matching_name_and_organization";
  personIds: string[];
  people: PersonRow[];
}

// PEO-002 "Merge operations are reversible" — GET /v1/people/merge-lineage does a plain (unmapped) Drizzle
// join of person_merge_lineage + people, so the JSON keys back are the raw DB table names, not the
// camelCase JS identifiers this codebase's OTHER joins normally return via an explicit `.select({...})`
// field map (see e.g. HouseholdService's `{ household, membership }` joins). Confirmed against the actual
// query builder (drizzle's `getTableLikeName` resolves to `Table.Symbol.BaseName`, i.e. the string first
// passed to `pgTable(...)`) rather than guessed — this is a real quirk of that one endpoint, not a typo
// here. `people` below is the SURVIVING person's row (the join target), used only to show "merged into X".
interface MergeLineageRow {
  person_merge_lineage: {
    id: string;
    survivingPersonId: string;
    mergedPersonId: string;
    mergedPersonSnapshot: { displayName?: string };
    actorUserId: string;
    mergedAt: string;
    unmergedAt: string | null;
  };
  people: PersonRow;
}

/**
 * PEO-002 "ambiguous merges require review" — precision-first candidate groups (matching email, matching
 * phone, or matching name+organization), NEVER auto-merged; the user always picks which row survives. A
 * group can have more than two members (e.g. three rows sharing one email), so this merges one pair at a
 * time — pick a survivor, then merge each other member into it; the group naturally shrinks and disappears
 * once only one row is left. Also surfaces past merges with a one-tap "Undo" for anything not already
 * reversed (`unmergedAt === null`).
 */
export default function MergePeopleScreen() {
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
    Promise.all([api.get<MergeCandidateGroup[]>("/v1/people/merge-candidates"), api.get<MergeLineageRow[]>("/v1/people/merge-lineage")])
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

  async function merge(survivingPersonId: string, mergedPersonId: string) {
    setMergingId(mergedPersonId);
    setActionError(null);
    try {
      await api.post("/v1/people/merge", { survivingPersonId, mergedPersonId });
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
      await api.post(`/v1/people/merge-lineage/${lineageId}/unmerge`);
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

  const activeLineage = (lineage ?? []).filter((row) => !row.person_merge_lineage.unmergedAt);

  return (
    <Screen>
      <ScreenHeader title="Possible duplicates" subtitle="Merges are never automatic — you always pick which one survives, and every merge can be undone." />

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {candidates === null && <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}

      {candidates?.length === 0 && <EmptyState title="No duplicates found" description="Veynlo checks for people sharing an email, phone number, or name and organization." />}

      {candidates && candidates.length > 0 && (
        <View style={{ gap: 10 }}>
          {candidates.map((group, i) => {
            const survivorId = survivorByGroup[i] ?? group.personIds[0];
            const others = group.people.filter((p) => p.id !== survivorId);
            return (
              <Card key={group.personIds.join(",")} style={{ gap: 8 }}>
                <Badge tone="warning">{mergeReasonText(group.reason)}</Badge>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Pick which one to keep:</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {group.people.map((p) => (
                    <Pressable accessibilityRole="button"
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
                      <Text style={{ fontSize: 13, color: survivorId === p.id ? theme.colors.brandDefault : theme.colors.textPrimary }}>{p.displayName}</Text>
                    </Pressable>
                  ))}
                </View>
                {others.map((p) => (
                  <View key={p.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Merge &quot;{p.displayName}&quot; into the one you kept</Text>
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
            const mergedName = row.person_merge_lineage.mergedPersonSnapshot?.displayName ?? "A person";
            const survivorName = row.people.displayName;
            return (
              <Card key={row.person_merge_lineage.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
                  &quot;{mergedName}&quot; was merged into &quot;{survivorName}&quot; on {new Date(row.person_merge_lineage.mergedAt).toLocaleDateString()}
                </Text>
                <Button variant="secondary" onPress={() => undo(row.person_merge_lineage.id)} loading={undoingId === row.person_merge_lineage.id}>
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
