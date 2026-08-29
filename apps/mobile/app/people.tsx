import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { TextField } from "@/components/text-field";

interface Person {
  id: string;
  displayLabel: string;
  relationshipLabel: string | null;
  importantDates: Array<{ label: string; dateIso: string }>;
}

interface MergeLineageEntry {
  id: string;
  survivingEntityId: string;
  mergedEntityId: string;
  survivingDisplayLabel: string | null;
  mergedDisplayLabel: string | null;
  unmergedAt: string | null;
}

export default function PeopleScreen() {
  const { theme } = useAppTheme();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [duplicateGroups, setDuplicateGroups] = useState<Person[][] | null>(null);
  const [mergeLineage, setMergeLineage] = useState<MergeLineageEntry[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [peopleResult, duplicatesResult, lineageResult] = await Promise.all([
      api.get<Person[]>("/v1/people"),
      api.get<Person[][]>("/v1/people/duplicate-candidates"),
      api.get<MergeLineageEntry[]>("/v1/people/merge-lineage"),
    ]);
    setPeople(peopleResult);
    setDuplicateGroups(duplicatesResult);
    setMergeLineage(lineageResult);
  }, []);

  async function mergeInto(survivingId: string, mergedId: string) {
    setMergeError(null);
    setMergeBusy(true);
    try {
      await api.post("/v1/people/merge", { survivingId, mergedId });
      await load();
    } catch (err) {
      setMergeError(err instanceof ApiError ? err.message : "Couldn't merge those contacts. Please try again.");
    } finally {
      setMergeBusy(false);
    }
  }

  async function undoMerge(lineageId: string) {
    setMergeError(null);
    setMergeBusy(true);
    try {
      await api.post(`/v1/people/merge-lineage/${lineageId}/unmerge`);
      await load();
    } catch (err) {
      setMergeError(err instanceof ApiError ? err.message : "Couldn't undo that merge. Please try again.");
    } finally {
      setMergeBusy(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function createPerson() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.post("/v1/people", { displayLabel: name });
      setName("");
      setShowForm(false);
      await load();
    } finally {
      setCreating(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="People" subtitle="The people, caregivers, and providers in your life." />

      <Button variant="secondary" onPress={() => setShowForm((v) => !v)}>
        {showForm ? "Cancel" : "Add person"}
      </Button>

      {showForm && (
        <Card style={{ gap: 10 }}>
          <TextField label="Name" value={name} onChangeText={setName} placeholder="Jamie Smith" />
          <Button loading={creating} disabled={!name.trim()} onPress={createPerson}>
            Save
          </Button>
        </Card>
      )}

      {mergeError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{mergeError}</Text>}

      {duplicateGroups && duplicateGroups.length > 0 && (
        <Card style={{ gap: 10 }}>
          <View>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Possible duplicates</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Grouped by a similar name — review before merging.</Text>
          </View>
          {duplicateGroups.map((group) => {
            const [survivor, ...rest] = group;
            if (!survivor) return null;
            return (
              <View key={group.map((p) => p.id).join(",")} style={{ gap: 6, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 10 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{group.map((p) => p.displayLabel).join(", ")}</Text>
                {rest.map((toMerge) => (
                  <Button key={toMerge.id} variant="ghost" disabled={mergeBusy} onPress={() => mergeInto(survivor.id, toMerge.id)}>
                    {`Merge into "${survivor.displayLabel}"`}
                  </Button>
                ))}
              </View>
            );
          })}
        </Card>
      )}

      {mergeLineage && mergeLineage.filter((e) => !e.unmergedAt).length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Recent merges</Text>
          {mergeLineage
            .filter((e) => !e.unmergedAt)
            .map((entry) => (
              <View key={entry.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textSecondary, flex: 1 }}>
                  {`Merged "${entry.mergedDisplayLabel ?? entry.mergedEntityId}" into "${entry.survivingDisplayLabel ?? entry.survivingEntityId}"`}
                </Text>
                <Button variant="ghost" disabled={mergeBusy} onPress={() => undoMerge(entry.id)}>
                  Undo
                </Button>
              </View>
            ))}
        </Card>
      )}

      {!people && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}
      {people?.length === 0 && (
        <EmptyState title="No people added yet" description="Add family members, caregivers, or providers to keep their important dates and history in one place." />
      )}
      {people && people.length > 0 && (
        <View style={{ gap: 8 }}>
          {people.map((p) => (
            <Pressable key={p.id} onPress={() => router.push(`/person/${p.id}`)}>
              <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.displayLabel}</Text>
                  {p.importantDates.length > 0 && (
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                      {p.importantDates.map((d) => `${d.label} ${d.dateIso}`).join(" · ")}
                    </Text>
                  )}
                </View>
                {p.relationshipLabel && <Badge tone="neutral">{p.relationshipLabel}</Badge>}
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}
