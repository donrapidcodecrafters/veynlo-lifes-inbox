import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { TextField } from "@/components/text-field";
import { HistorySection } from "@/components/history-section";

interface Person {
  id: string;
  displayLabel: string;
  relationshipLabel: string | null;
  importantDates: Array<{ label: string; dateIso: string }>;
}

export default function PersonDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<Person | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api.get<Person>(`/v1/people/${id}`).then((p) => {
      setData(p);
      setName(p.displayLabel);
      setRelationship(p.relationshipLabel ?? "");
    });
  }, [id]);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/v1/people/${id}`, { displayLabel: name, relationshipLabel: relationship || null });
    } finally {
      setSaving(false);
    }
  }

  async function deletePerson() {
    setDeleting(true);
    try {
      await api.delete(`/v1/people/${id}`);
      router.back();
    } finally {
      setDeleting(false);
    }
  }

  if (data === undefined) {
    return (
      <Screen>
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This person doesn't exist or you don't have access to them." />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title={data.displayLabel} />

      <Card style={{ gap: 10 }}>
        <TextField label="Name" value={name} onChangeText={setName} />
        <TextField label="Relationship" value={relationship} onChangeText={setRelationship} placeholder="spouse, child, caregiver…" />
        {data.importantDates.length > 0 && (
          <View style={{ gap: 4 }}>
            {data.importantDates.map((d, i) => (
              <Text key={i} style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                {d.label}: {d.dateIso}
              </Text>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button loading={saving} onPress={save}>
              Save
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button variant="critical" loading={deleting} onPress={deletePerson}>
              Delete
            </Button>
          </View>
        </View>
        {data.relationshipLabel && <Badge tone="neutral">{data.relationshipLabel}</Badge>}
      </Card>

      <HistorySection resourceType="person" resourceId={data.id} />
    </Screen>
  );
}
