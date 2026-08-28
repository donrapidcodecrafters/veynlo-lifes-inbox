import { useCallback, useState } from "react";
import { Linking, RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface DocumentRow {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
}

const STATE_TONE: Record<string, "positive" | "warning" | "neutral"> = {
  extracted: "positive",
  verified: "positive",
  classified: "neutral",
  uploaded: "neutral",
  malware_scan: "warning",
  ocr_parsing: "warning",
};

export default function DocumentsScreen() {
  const { theme } = useAppTheme();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDocuments(await api.get<DocumentRow[]>("/v1/documents"));
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

  async function openDocument(id: string) {
    setOpeningId(id);
    try {
      const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
      await Linking.openURL(url);
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Documents" subtitle="Receipts, warranties, manuals, and anything else worth keeping." />

      {!documents && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {documents?.length === 0 && (
        <EmptyState
          title="No documents yet"
          description="Upload a receipt, warranty card, or manual from the web app and Veynlo will read the text automatically so you can search it later."
        />
      )}

      {documents && documents.length > 0 && (
        <View style={{ gap: 8 }}>
          {documents.map((doc) => (
            <Card key={doc.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }} numberOfLines={1}>
                  {doc.title}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>
                  {doc.documentType.replace(/_/g, " ")}
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Badge tone={STATE_TONE[doc.processingState] ?? "neutral"}>{doc.processingState.replace(/_/g, " ")}</Badge>
                <Button variant="ghost" onPress={() => openDocument(doc.id)} loading={openingId === doc.id}>
                  Open
                </Button>
              </View>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
