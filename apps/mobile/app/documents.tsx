import { useCallback, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { ScreenHeader } from "@/components/screen-header";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { TextField } from "@/components/text-field";

interface DocumentRow {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
  // HH-002 "Each object shows a privacy badge: Private, Household, Selected People, Shared Link" —
  // mirrors apps/web's documents/page.tsx; computed server-side by DocumentsService.computeSharingStates.
  sharingState?: "private" | "household" | "selected_people" | "shared_link";
}

// §40.3 Document state machine — mirrors apps/web's documents/page.tsx DOCUMENT_FILTERS/DocumentFilter;
// see DocumentsService.list's own doc comment for what each value excludes/includes.
const DOCUMENT_FILTERS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "superseded", label: "Superseded" },
  { value: "all", label: "All" },
] as const;
type DocumentFilter = (typeof DOCUMENT_FILTERS)[number]["value"];

// HLTH-002 — these two default to the "highly_sensitive" tier and always require a fresh password
// (step-up) to open, even for the owner. Mirrors apps/web's documents/page.tsx HEALTH_DOCUMENT_TYPES and
// HealthLogisticsService's own doc comment. This screen was missing the gate entirely (confirmed live:
// it called the ordinary /v1/documents/:id/download-url route for every documentType, same as
// document/[id].tsx) — health-appointment/[id].tsx's DocumentsPanel already has the mobile-side pattern
// for the POST /v1/health/documents/:id/unlock step-up flow this reuses.
const HEALTH_DOCUMENT_TYPES = new Set(["insurance_card", "eob"]);

interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

// Mirrors apps/web's (app)/documents/page.tsx DOCUMENT_TYPES list and order exactly — this list was
// missing "Insurance card" and "Explanation of benefits (EOB)" (confirmed live: 13 options here vs. 14 on
// web), the two HLTH-002 health-tagged types that always require step-up to open.
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
  { value: "insurance_card", label: "Insurance card" },
  { value: "eob", label: "Explanation of benefits (EOB)" },
  { value: "other", label: "Other" },
];

const STATE_TONE: Record<string, "positive" | "warning" | "neutral"> = {
  extracted: "positive",
  linked: "positive",
  verified: "positive",
  classified: "neutral",
  uploaded: "neutral",
  malware_scan: "warning",
  ocr_parsing: "warning",
  archived: "neutral",
  superseded: "warning",
  deleted: "neutral",
};

const PRIVACY_LABEL: Record<NonNullable<DocumentRow["sharingState"]>, string> = {
  private: "Private",
  household: "Household",
  selected_people: "Selected people",
  shared_link: "Shared link",
};

const PRIVACY_TONE: Record<NonNullable<DocumentRow["sharingState"]>, "neutral" | "warning" | "positive"> = {
  private: "neutral",
  household: "positive",
  selected_people: "positive",
  shared_link: "warning",
};

export default function DocumentsScreen() {
  const { theme } = useAppTheme();
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  // HLTH-002 step-up — mirrors identity-record/[id].tsx's RevealDocumentNumberPanel and
  // health-appointment/[id].tsx's DocumentsPanel: try with no password first (a no-op for the ordinary
  // download-url path below), only prompt when the server actually asks (PASSWORD_REQUIRED).
  const [passwordPromptId, setPasswordPromptId] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState("receipt");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // §40.3 Document state machine — mirrors apps/web's documents/page.tsx filter tabs; see
  // DocumentsService.list's own doc comment for what each value excludes/includes.
  const [filter, setFilter] = useState<DocumentFilter>("active");
  const [stateActionId, setStateActionId] = useState<string | null>(null);
  const [stateActionError, setStateActionError] = useState<string | null>(null);
  // Found live: the "Delete" button below called deleteDocument directly on one tap — no confirmation at
  // all, unlike every other destructive action in this app (connections.tsx's disconnect+delete,
  // list/[id].tsx's item delete, apps/web's own documents page delete). One misclick had no recovery path.
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Confirmed live elsewhere in this screen's own ShareDocumentPanel (see below) and in timeline.tsx: an
  // unguarded fetch here becomes an unhandled promise rejection on any transient network failure —
  // useFocusEffect below doesn't await this call, so there's nowhere else to catch it — which React Native
  // Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just this list.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDocuments(await api.get<DocumentRow[]>(`/v1/documents?filter=${filter}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load your documents. Please try again.");
    }
  }, [filter]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // §40.3 "archived" — a quick single-tap soft-hide/restore from the list, mirroring apps/web's own
  // Archive/Unarchive buttons; verify/supersede stay on the detail screen (document/[id].tsx) since both
  // benefit from seeing the extracted text/lineage before acting.
  async function toggleArchive(doc: DocumentRow) {
    setStateActionId(doc.id);
    setStateActionError(null);
    try {
      await api.put(`/v1/documents/${doc.id}/${doc.processingState === "archived" ? "unarchive" : "archive"}`);
      await load();
    } catch (err) {
      setStateActionError(err instanceof ApiError ? err.message : "Couldn't update this document. Please try again.");
    } finally {
      setStateActionId(null);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function openDocument(id: string, documentType: string, withPassword?: string) {
    setOpeningId(id);
    setOpenError(null);
    try {
      // HLTH-002 — a health-tagged document always requires a fresh step-up password, even for the owner
      // (HealthLogisticsService.openHealthDocument), so this can't just hit the ordinary download-url
      // route. Mirrors apps/web's documents/page.tsx openDocument exactly.
      if (HEALTH_DOCUMENT_TYPES.has(documentType)) {
        const { url } = await api.post<{ url: string }>(`/v1/health/documents/${id}/unlock`, { password: withPassword });
        setPasswordPromptId(null);
        setPassword("");
        await Linking.openURL(url);
        return;
      }
      const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
      await Linking.openURL(url);
    } catch (err) {
      if (HEALTH_DOCUMENT_TYPES.has(documentType) && err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptId(id);
        return;
      }
      setOpenError(err instanceof ApiError ? err.message : "Couldn't open this document. Please try again.");
    } finally {
      setOpeningId(null);
    }
  }

  async function deleteDocument(id: string) {
    setDeletingId(id);
    setDeleteError(null);
    try {
      await api.delete(`/v1/documents/${id}`);
      setConfirmingDeleteId(null);
      await load();
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Couldn't delete this document. Please try again.");
    } finally {
      setDeletingId(null);
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
      {/* Found live via a simulated 500: an un-retryable plain red text line with no way to recover short
          of leaving and re-entering the screen (pull-to-refresh works but isn't discoverable as "the
          retry") — same gap already closed on inbox.tsx/connections.tsx/(tabs)/index.tsx via FetchError.
          Only shown pre-first-load (mirrors those screens); a refresh failure after documents already
          loaded keeps showing the existing list with the plain-text banner below instead of replacing it. */}
      {documents && loadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{loadError}</Text>}
      {stateActionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{stateActionError}</Text>}
      {openError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{openError}</Text>}

      {/* §40.3 Document state machine — "Active" is the default; "Archived"/"Superseded" surface documents
          hidden from the default vault view without leaving them unreachable. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {DOCUMENT_FILTERS.map((f) => {
          const active = filter === f.value;
          return (
            <Text
              accessibilityRole="button"
              key={f.value}
              onPress={() => setFilter(f.value)}
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
              {f.label}
            </Text>
          );
        })}
      </ScrollView>

      <View style={{ gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {DOCUMENT_TYPES.map((t) => {
            const active = documentType === t.value;
            return (
              <Text accessibilityRole="button"
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

      {!documents && !loadError && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}

      {!documents && loadError && <FetchError what="your documents" message={loadError} onRetry={load} />}

      {documents?.length === 0 && (
        <EmptyState
          title="No documents yet"
          description="Scan a receipt, or choose a photo or file above, and Veynlo will read the text automatically so you can search it later."
        />
      )}

      {documents && documents.length > 0 && (
        <View style={{ gap: 8 }}>
          {documents.map((doc) => (
            <Card key={doc.id} style={{ gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                {/* Tapping the row opens the in-app detail screen (OCR'd text, etc.) — the "Open" button
                    below stays as the separate shortcut straight to the raw file, unchanged. */}
                <Pressable accessibilityRole="button" style={{ flex: 1 }} onPress={() => router.push(`/document/${doc.id}`)}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }} numberOfLines={1}>
                    {doc.title}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>
                    {doc.documentType.replace(/_/g, " ")}
                  </Text>
                </Pressable>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Badge tone={PRIVACY_TONE[doc.sharingState ?? "private"]}>{PRIVACY_LABEL[doc.sharingState ?? "private"]}</Badge>
                  <Badge tone={STATE_TONE[doc.processingState] ?? "neutral"}>{doc.processingState.replace(/_/g, " ")}</Badge>
                </View>
              </View>
              {confirmingDeleteId !== doc.id && (
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <Button variant="ghost" onPress={() => openDocument(doc.id, doc.documentType)} loading={openingId === doc.id}>
                    {HEALTH_DOCUMENT_TYPES.has(doc.documentType) ? "Unlock & open" : "Open"}
                  </Button>
                  <Button variant="ghost" onPress={() => setSharingId(sharingId === doc.id ? null : doc.id)}>
                    Share
                  </Button>
                  {/* §40.3 "archived" — a soft-hide distinct from delete; still reachable via the "Archived"
                      filter above. Verify/"mark superseded" live on the detail screen instead of here. */}
                  {doc.processingState !== "deleted" && (
                    <Button variant="ghost" onPress={() => toggleArchive(doc)} loading={stateActionId === doc.id}>
                      {doc.processingState === "archived" ? "Unarchive" : "Archive"}
                    </Button>
                  )}
                  <Button variant="ghost" onPress={() => setConfirmingDeleteId(doc.id)}>
                    Delete
                  </Button>
                </View>
              )}
              {/* HLTH-002 step-up — same password-prompt shape as identity-record/[id].tsx's
                  RevealDocumentNumberPanel and health-appointment/[id].tsx's DocumentsPanel. */}
              {passwordPromptId === doc.id && (
                <View style={{ gap: 8 }}>
                  <TextField
                    label="Confirm your password to open this"
                    secureTextEntry
                    autoComplete="current-password"
                    value={password}
                    onChangeText={setPassword}
                    autoFocus
                  />
                  <Button onPress={() => openDocument(doc.id, doc.documentType, password)} loading={openingId === doc.id}>
                    Unlock
                  </Button>
                </View>
              )}
              {confirmingDeleteId === doc.id && (
                <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
                    Delete &quot;{doc.title}&quot;? This can&apos;t be undone.
                  </Text>
                  {deleteError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{deleteError}</Text>}
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button onPress={() => deleteDocument(doc.id)} loading={deletingId === doc.id}>
                      Confirm delete
                    </Button>
                    <Button
                      variant="ghost"
                      onPress={() => {
                        setConfirmingDeleteId(null);
                        setDeleteError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </View>
                </View>
              )}
              {sharingId === doc.id && <ShareResourcePanel resourceId={doc.id} collectionPath="/v1/documents" resourceLabel="document" />}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
