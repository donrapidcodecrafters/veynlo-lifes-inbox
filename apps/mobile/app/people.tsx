import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api } from "@/lib/api-client";
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

export default function PeopleScreen() {
  const { theme } = useAppTheme();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setPeople(await api.get<Person[]>("/v1/people"));
  }, []);

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
