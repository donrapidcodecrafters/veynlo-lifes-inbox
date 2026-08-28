import { useCallback, useState } from "react";
import { Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { api, ApiError } from "@/lib/api-client";
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

interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

const DOCUMENT_TYPES = [
  { value: "receipt", label: "Receipt" },
  { value: "warranty", label: "Warranty" },
  { value: "insurance_policy", label: "Insurance" },
  { value: "contract", label: "Contract" },
  { value: "manual", label: "Manual" },
  { value: "tax_document", label: "Tax" },
  { value: "registration", label: "Registration" },
  { value: "title", label: "Title" },
  { value: "identity_document", label: "Identity" },
  { value: "membership_document", label: "Membership" },
  { value: "statement", label: "Statement" },
  { value: "invitation", label: "Invitation" },
  { value: "other", label: "Other" },
];

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
  const [documentType, setDocumentType] = useState("receipt");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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

  async function doUpload(file: PickedFile) {
    setUploading(true);
    setUploadError(null);
    try {
      await api.upload("/v1/documents/upload", { title: file.name, documentType }, file);
      await load();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setUploadError("Camera access is off — enable it in your device settings to scan a document.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    await doUpload({ uri: asset.uri, name: asset.fileName ?? `scan-${Date.now()}.jpg`, type: asset.mimeType ?? "image/jpeg" });
  }

  async function choosePhoto() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      setUploadError("Photo library access is off — enable it in your device settings to attach a photo.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    await doUpload({ uri: asset.uri, name: asset.fileName ?? `photo-${Date.now()}.jpg`, type: asset.mimeType ?? "image/jpeg" });
  }

  async function chooseFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*", "text/plain"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    await doUpload({ uri: asset.uri, name: asset.name, type: asset.mimeType ?? "application/octet-stream" });
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Documents" subtitle="Receipts, warranties, manuals, and anything else worth keeping." />

      <View style={{ gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {DOCUMENT_TYPES.map((t) => {
            const active = documentType === t.value;
            return (
              <Text
                key={t.value}
                onPress={() => setDocumentType(t.value)}
                style={{
                  fontSize: 13,
                  fontWeight: "600",
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: theme.radius.full,
                  backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                  color: active ? theme.colors.textOnBrand : theme.colors.textSecondary,
                  overflow: "hidden",
                }}
              >
                {t.label}
              </Text>
            );
          })}
        </ScrollView>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Button variant="secondary" onPress={takePhoto} loading={uploading}>
              Scan
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button variant="secondary" onPress={choosePhoto} loading={uploading}>
              Photo
            </Button>
          </View>
          <View style={{ flex: 1 }}>
            <Button variant="secondary" onPress={chooseFile} loading={uploading}>
              File
            </Button>
          </View>
        </View>
        {uploadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{uploadError}</Text>}
      </View>

      {!documents && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {documents?.length === 0 && (
        <EmptyState
          title="No documents yet"
          description="Scan a receipt, or choose a photo or file above, and Veynlo will read the text automatically so you can search it later."
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
