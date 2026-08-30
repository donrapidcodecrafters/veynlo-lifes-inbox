import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
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

interface LinkedItems {
  purchases: Array<{ id: string; merchantName: string | null }>;
  bills: Array<{ id: string; billerLabel: string }>;
  warranties: Array<{ id: string; productLabel: string }>;
  events: Array<{ id: string; title: string }>;
}

type LinkableType = "purchase" | "bill" | "warranty" | "event";

const LINKABLE_TYPES: Array<{ value: LinkableType; label: string; listUrl: string; detailRoute: string; endpointSegment: string }> = [
  { value: "purchase", label: "Purchase", listUrl: "/v1/purchases", detailRoute: "/purchase", endpointSegment: "purchases" },
  { value: "bill", label: "Bill", listUrl: "/v1/bills", detailRoute: "/bill", endpointSegment: "bills" },
  { value: "warranty", label: "Warranty", listUrl: "/v1/warranties", detailRoute: "/warranty", endpointSegment: "warranties" },
  { value: "event", label: "Appointment", listUrl: "/v1/events", detailRoute: "/event", endpointSegment: "events" },
];

export default function PersonDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<Person | null | undefined>(undefined);
  const [linkedItems, setLinkedItems] = useState<LinkedItems | null>(null);
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

  const loadLinkedItems = useCallback(async () => {
    setLinkedItems(await api.get<LinkedItems>(`/v1/people/${id}/linked-items`));
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadLinkedItems();
    }, [loadLinkedItems]),
  );

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

      <LinkedItemsCard personId={data.id} items={linkedItems} onChange={loadLinkedItems} />

      <HistorySection resourceType="person" resourceId={data.id} />
    </Screen>
  );
}

/** PEO-004 "person linkage" — every purchase/bill/warranty/appointment manually linked to this person. */
function LinkedItemsCard({ personId, items, onChange }: { personId: string; items: LinkedItems | null; onChange: () => Promise<void> }) {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [addingType, setAddingType] = useState<LinkableType | null>(null);
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startAdding(type: LinkableType) {
    setAddingType(type);
    setError(null);
    setLoadingCandidates(true);
    try {
      const config = LINKABLE_TYPES.find((t) => t.value === type)!;
      const rows = await api.get<Array<Record<string, unknown>>>(config.listUrl);
      setCandidates(
        rows.map((r) => ({
          id: r.id as string,
          label:
            type === "purchase"
              ? ((r.merchantName as string | null) ?? "Untitled purchase")
              : type === "bill"
                ? (r.billerLabel as string)
                : type === "warranty"
                  ? (r.productLabel as string)
                  : (r.title as string),
        })),
      );
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function pick(candidateId: string) {
    if (!addingType) return;
    setSavingId(candidateId);
    setError(null);
    try {
      const config = LINKABLE_TYPES.find((t) => t.value === addingType)!;
      await api.post(`/v1/${config.endpointSegment}/${candidateId}/link-person`, { personId });
      setAddingType(null);
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that item.");
    } finally {
      setSavingId(null);
    }
  }

  async function unlink(type: LinkableType, itemId: string) {
    const config = LINKABLE_TYPES.find((t) => t.value === type)!;
    await api.post(`/v1/${config.endpointSegment}/${itemId}/unlink-person`, { personId });
    await onChange();
  }

  if (!items) return null;
  const hasAny = items.purchases.length > 0 || items.bills.length > 0 || items.warranties.length > 0 || items.events.length > 0;

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Linked items</Text>
      {!hasAny && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Nothing linked to this person yet.</Text>}

      {items.purchases.map((p) => (
        <LinkedItemRow key={p.id} label={p.merchantName ?? "Untitled purchase"} onPress={() => router.push(`/purchase/${p.id}`)} onUnlink={() => unlink("purchase", p.id)} />
      ))}
      {items.bills.map((b) => (
        <LinkedItemRow key={b.id} label={b.billerLabel} onPress={() => router.push(`/bill/${b.id}`)} onUnlink={() => unlink("bill", b.id)} />
      ))}
      {items.warranties.map((w) => (
        <LinkedItemRow key={w.id} label={w.productLabel} onPress={() => router.push(`/warranty/${w.id}`)} onUnlink={() => unlink("warranty", w.id)} />
      ))}
      {items.events.map((e) => (
        <LinkedItemRow key={e.id} label={e.title} onPress={() => router.push(`/event/${e.id}`)} onUnlink={() => unlink("event", e.id)} />
      ))}

      {!addingType && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
          {LINKABLE_TYPES.map((t) => (
            <Button key={t.value} variant="secondary" onPress={() => startAdding(t.value)}>
              {`Link a ${t.label.toLowerCase()}`}
            </Button>
          ))}
        </View>
      )}

      {addingType && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
          {loadingCandidates && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
          {!loadingCandidates && candidates.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Nothing to link yet.</Text>}
          {!loadingCandidates &&
            candidates.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => pick(c.id)}
                disabled={savingId === c.id}
                accessibilityRole="button"
                accessibilityLabel={savingId === c.id ? "Linking…" : c.label}
                style={{ paddingVertical: 8 }}
              >
                <Text style={{ fontSize: 13, color: theme.colors.brandDefault }}>{savingId === c.id ? "Linking…" : c.label}</Text>
              </Pressable>
            ))}
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <Button variant="ghost" onPress={() => setAddingType(null)}>
            Cancel
          </Button>
        </View>
      )}
    </Card>
  );
}

function LinkedItemRow({ label, onPress, onUnlink }: { label: string; onPress: () => void; onUnlink: () => void }) {
  const { theme } = useAppTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label}>
        <Text style={{ fontSize: 13, color: theme.colors.brandDefault }}>{label}</Text>
      </Pressable>
      <Pressable onPress={onUnlink} accessibilityRole="button" accessibilityLabel={`Unlink ${label}`}>
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Unlink</Text>
      </Pressable>
    </View>
  );
}
