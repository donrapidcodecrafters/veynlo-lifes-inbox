import { useCallback, useState } from "react";
import { Linking, Pressable, RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface SavedItem {
  id: string;
  title: string;
  url: string | null;
  note: string | null;
  category: string;
  tags: string[];
  pinned: boolean;
}

export default function SavedScreen() {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<SavedItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setItems(await api.get<SavedItem[]>("/v1/saved-items"));
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

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Saved" subtitle="Links, notes, and anything else worth remembering." />

      <Button variant="secondary" onPress={() => setAdding((v) => !v)}>
        {adding ? "Cancel" : "Save something"}
      </Button>

      {adding && (
        <Card>
          <AddForm onDone={() => { setAdding(false); load(); }} />
        </Card>
      )}

      {!items && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {items?.length === 0 && (
        <EmptyState
          title="Nothing saved yet"
          description="Save a link, a quick note, or anything else you want to come back to later."
        />
      )}

      {items && items.length > 0 && (
        <View style={{ gap: 8 }}>
          {items.map((item) => (
            <Card key={item.id} style={{ gap: 10 }}>
              <Pressable
                onPress={() => setExpandedId(expandedId === item.id ? null : item.id)}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }} numberOfLines={1}>
                    {item.pinned ? "📌 " : ""}
                    {item.title}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }} numberOfLines={1}>
                    {item.url ?? item.note ?? ""}
                    {item.tags.length > 0 ? ` · ${item.tags.join(", ")}` : ""}
                  </Text>
                </View>
                <Badge tone="neutral">{item.category}</Badge>
              </Pressable>
              {expandedId === item.id && <ItemEditor item={item} onChanged={load} />}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api.post("/v1/saved-items", { title, url: url || undefined, note: note || undefined });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <TextField label="Title" value={title} onChangeText={setTitle} />
      <TextField label="Link (optional)" value={url} onChangeText={setUrl} keyboardType="url" autoCapitalize="none" />
      <TextField label="Note (optional)" value={note} onChangeText={setNote} multiline />
      {error && <Text style={{ fontSize: 13, color: "#dc2626" }}>{error}</Text>}
      <Button onPress={submit} loading={saving}>
        Save
      </Button>
    </View>
  );
}

function ItemEditor({ item, onChanged }: { item: SavedItem; onChanged: () => Promise<void> }) {
  const { theme } = useAppTheme();
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/saved-items/${item.id}`, {
        title,
        note,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePin() {
    await api.patch(`/v1/saved-items/${item.id}`, { pinned: !item.pinned });
    await onChanged();
  }

  async function archive() {
    await api.patch(`/v1/saved-items/${item.id}`, { archived: true });
    await onChanged();
  }

  async function remove() {
    await api.delete(`/v1/saved-items/${item.id}`);
    await onChanged();
  }

  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
      <TextField label="Title" value={title} onChangeText={setTitle} />
      <TextField label="Note" value={note} onChangeText={setNote} multiline />
      <TextField label="Tags (comma-separated)" value={tags} onChangeText={setTags} />
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
      {item.url && (
        <Button variant="ghost" onPress={() => Linking.openURL(item.url!)}>
          Open link
        </Button>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button onPress={save} loading={saving}>
          Save changes
        </Button>
        <Button variant="ghost" onPress={togglePin}>
          {item.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button variant="ghost" onPress={archive}>
          Archive
        </Button>
        <Button variant="critical" onPress={remove}>
          Delete
        </Button>
      </View>
    </View>
  );
}
