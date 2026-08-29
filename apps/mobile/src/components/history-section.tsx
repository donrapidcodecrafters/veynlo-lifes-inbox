import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

interface HistoryNote {
  id: string;
  noteText: string;
  createdAt: string;
}

interface HistoryDocument {
  id: string;
  title: string;
  documentType: string;
}

interface RelatedItem {
  kind: "shipment" | "return_case" | "warranty";
  id: string;
  label: string;
  at: string;
}

interface HistoryResponse {
  notes: HistoryNote[];
  documents: HistoryDocument[];
  related: RelatedItem[];
}

const RELATED_LABEL: Record<RelatedItem["kind"], string> = {
  shipment: "Shipment",
  return_case: "Return",
  warranty: "Warranty",
};

/** TIME-002 "Object history" — mirrors the web version's identical component. "Compare versions" isn't offered — there's no revision table behind any of these domains yet. */
export function HistorySection({
  resourceType,
  resourceId,
  showRelatedKinds,
}: {
  resourceType: string;
  resourceId: string;
  showRelatedKinds?: RelatedItem["kind"][];
}) {
  const { theme } = useAppTheme();
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [noteText, setNoteText] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.get<HistoryResponse>(`/v1/history/${resourceType}/${resourceId}`).catch(() => null);
    setData(res);
  }, [resourceType, resourceId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function addNote() {
    if (!noteText.trim()) return;
    setSubmittingNote(true);
    try {
      await api.post(`/v1/history/${resourceType}/${resourceId}/notes`, { noteText });
      setNoteText("");
      await load();
    } finally {
      setSubmittingNote(false);
    }
  }

  async function attachDocument() {
    setError(null);
    const result = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*", "text/plain"], copyToCacheDirectory: true });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setUploading(true);
    try {
      await api.upload(
        "/v1/documents/upload",
        { title: asset.name, documentType: "other", linkedResourceId: resourceId },
        { uri: asset.uri, name: asset.name, type: asset.mimeType ?? "application/octet-stream" },
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  const related = data?.related.filter((r) => !showRelatedKinds || showRelatedKinds.includes(r.kind)) ?? [];

  return (
    <Card style={{ gap: 12 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>History</Text>

      {related.length > 0 && (
        <View style={{ gap: 2 }}>
          {related.map((r) => (
            <Text key={`${r.kind}-${r.id}`} style={{ fontSize: 13, color: theme.colors.textSecondary }}>
              {RELATED_LABEL[r.kind]} — {r.label}
            </Text>
          ))}
        </View>
      )}

      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
        <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Documents</Text>
        {data?.documents.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No documents attached yet.</Text>}
        {data?.documents.map((d) => (
          <Text key={d.id} style={{ fontSize: 13, color: theme.colors.textPrimary }}>
            {d.title}
          </Text>
        ))}
        {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
        <Button variant="secondary" loading={uploading} onPress={attachDocument}>
          Attach document
        </Button>
      </View>

      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
        <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Notes</Text>
        {data?.notes.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No notes yet.</Text>}
        {data?.notes.map((n) => (
          <View key={n.id} style={{ backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{n.noteText}</Text>
            <Text style={{ fontSize: 11, color: theme.colors.textTertiary, marginTop: 2 }}>{new Date(n.createdAt).toLocaleString()}</Text>
          </View>
        ))}
        <TextField label="Note" placeholder="Add a note…" value={noteText} onChangeText={setNoteText} multiline numberOfLines={2} />
        <Button variant="secondary" loading={submittingNote} disabled={!noteText.trim()} onPress={addNote}>
          Add note
        </Button>
      </View>
    </Card>
  );
}
