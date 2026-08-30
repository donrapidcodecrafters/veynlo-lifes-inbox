import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, Share, Switch, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Clipboard from "expo-clipboard";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface DocumentRow {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
  tags: string[];
  retentionPolicy: string;
  householdId: string | null;
  visibility: string;
}

const RETENTION_POLICIES = [
  { value: "full_original", label: "Keep original file" },
  { value: "extracted_only", label: "Keep extracted text only" },
  { value: "delete_after_processing", label: "Delete original after processing" },
] as const;

interface DocumentVersion {
  id: string;
  versionNumber: number;
  isCurrent: boolean;
  diffFromPrevious: { linesAdded: number; linesRemoved: number; unchanged: boolean } | null;
}

interface PickedFile {
  uri: string;
  name: string;
  type: string;
}

interface DocumentsPageResponse {
  items: DocumentRow[];
  nextCursor: string | null;
}

interface Member {
  userId: string | null;
  status: string;
  displayName: string | null;
}

interface ResourceGrant {
  id: string;
  granteeUserId: string;
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
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState("receipt");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDuplicate, setPendingDuplicate] = useState<{ file: PickedFile; duplicateOfTitle: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** DOC-007 "export packet" — no browser download here, so the ZIP is written to the cache directory and
   * handed to the OS share sheet (Save to Files, AirDrop, etc.) via expo-sharing. */
  async function exportSelected() {
    setExporting(true);
    setExportError(null);
    try {
      const buffer = await api.downloadBinary("/v1/documents/export", { documentIds: Array.from(selectedIds) });
      const destination = new File(Paths.cache, `veynlo-documents-${Date.now()}.zip`);
      destination.write(new Uint8Array(buffer));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(destination.uri, { mimeType: "application/zip" });
      }
      setSelectedIds(new Set());
    } catch (err) {
      setExportError(err instanceof ApiError ? err.message : "Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  // Backend-robustness fix — GET /v1/documents is now cursor-paginated rather than returning every
  // document unbounded. `load` always resets to page one; `loadMore` appends the next page.
  const load = useCallback(async () => {
    const res = await api.get<DocumentsPageResponse>("/v1/documents");
    setDocuments(res.items);
    setCursor(res.nextCursor);
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

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<DocumentsPageResponse>(`/v1/documents?before=${encodeURIComponent(cursor)}`);
      setDocuments((prev) => [...(prev ?? []), ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  async function openDocument(id: string, versionId?: string) {
    setOpeningId(id);
    try {
      const query = versionId ? `?versionId=${versionId}` : "";
      const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url${query}`);
      await Linking.openURL(url);
    } finally {
      setOpeningId(null);
    }
  }

  async function doUpload(file: PickedFile, force = false) {
    setUploading(true);
    setUploadError(null);
    try {
      const fields: Record<string, string> = { title: file.name, documentType };
      if (force) fields.force = "true";
      const result = await api.upload<{ documentId: string; duplicate?: true; duplicateOfTitle?: string }>(
        "/v1/documents/upload",
        fields,
        file,
      );
      if (result.duplicate) {
        setPendingDuplicate({ file, duplicateOfTitle: result.duplicateOfTitle ?? "an existing document" });
      } else {
        setPendingDuplicate(null);
        await load();
      }
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
    // §CAP-003 "Camera Scanner" — expo-image-picker has no document-edge-detection mode (that needs a
    // native scanner module and a dev-client rebuild, deferred for the same reason mobile voice input was:
    // see docs/ROADMAP.md), but `allowsEditing` does give a real crop/retake confirmation step before the
    // photo is used — a bounded, zero-new-dependency step toward the spec's fuller ask, not the full thing.
    const result = await ImagePicker.launchCameraAsync({ quality: 0.8, allowsEditing: true });
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

      {selectedIds.size > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{selectedIds.size} selected</Text>
          <Button variant="secondary" onPress={exportSelected} loading={exporting}>
            Export selected
          </Button>
        </View>
      )}
      {exportError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{exportError}</Text>}

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

      {pendingDuplicate && (
        <Card style={{ gap: 8, backgroundColor: theme.colors.bgSubtle }}>
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
            You already have &ldquo;{pendingDuplicate.duplicateOfTitle}&rdquo; — this looks like the same file.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button variant="ghost" onPress={() => doUpload(pendingDuplicate.file, true)} loading={uploading}>
              Upload anyway
            </Button>
            <Button variant="ghost" onPress={() => setPendingDuplicate(null)}>
              Cancel
            </Button>
          </View>
        </Card>
      )}

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
            <Card key={doc.id} style={{ gap: 10 }}>
              <Pressable
                onPress={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
                // Deliberately no accessibilityRole="button" here — this row contains its OWN separately
                // actionable children (the checkbox below, the "Open" button), and a "button" role on a
                // container with real interactive descendants renders as a literal nested <button> on web
                // (an HTML violation caught live via react-native-web) and is an ambiguous double-tap
                // target for a screen reader on native too.
                accessibilityLabel={expandedId === doc.id ? `Collapse ${doc.title}` : `Edit ${doc.title}`}
                style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}
              >
                <Pressable
                  onPress={() => toggleSelected(doc.id)}
                  hitSlop={8}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selectedIds.has(doc.id) }}
                  accessibilityLabel={`Select ${doc.title} for export`}
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: theme.radius.sm,
                    borderWidth: 1.5,
                    borderColor: selectedIds.has(doc.id) ? theme.colors.brandDefault : theme.colors.borderDefault,
                    backgroundColor: selectedIds.has(doc.id) ? theme.colors.brandDefault : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selectedIds.has(doc.id) && <Text style={{ fontSize: 12, color: theme.colors.textOnBrand, fontWeight: "700" }}>✓</Text>}
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }} numberOfLines={1}>
                    {doc.title}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>
                    {doc.documentType.replace(/_/g, " ")}
                    {doc.tags.length > 0 && ` · ${doc.tags.join(", ")}`}
                  </Text>
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Badge tone={STATE_TONE[doc.processingState] ?? "neutral"}>{doc.processingState.replace(/_/g, " ")}</Badge>
                  <Button variant="ghost" onPress={() => openDocument(doc.id)} loading={openingId === doc.id}>
                    Open
                  </Button>
                </View>
              </Pressable>
              {expandedId === doc.id && (
                <DocumentEditor
                  doc={doc}
                  onChanged={load}
                  onOpenVersion={openDocument}
                  onClose={() => setExpandedId(null)}
                />
              )}
            </Card>
          ))}
        </View>
      )}

      {cursor && (
        <View style={{ alignItems: "center", paddingTop: 4 }}>
          <Button variant="secondary" onPress={loadMore} loading={loadingMore}>
            Load more
          </Button>
        </View>
      )}
    </Screen>
  );
}

function DocumentEditor({
  doc,
  onChanged,
  onOpenVersion,
  onClose,
}: {
  doc: DocumentRow;
  onChanged: () => Promise<void>;
  onOpenVersion: (id: string, versionId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [title, setTitle] = useState(doc.title);
  const [documentType, setDocumentType] = useState(doc.documentType);
  const [tags, setTags] = useState(doc.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [replacingFile, setReplacingFile] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
  const [retentionPolicy, setRetentionPolicy] = useState(doc.retentionPolicy);
  const [visibility, setVisibility] = useState(doc.visibility);
  const [savingRetention, setSavingRetention] = useState(false);
  const [confirmingRetention, setConfirmingRetention] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<ResourceGrant[]>([]);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  useEffect(() => {
    if (!doc.householdId) return;
    api.get<Member[]>(`/v1/households/${doc.householdId}/members`).then(setMembers);
    api.get<ResourceGrant[]>(`/v1/documents/${doc.id}/grants`).then(setGrants);
  }, [doc.householdId, doc.id]);

  async function grantMember(granteeUserId: string) {
    setGranting(true);
    setGrantError(null);
    try {
      await api.post(`/v1/documents/${doc.id}/grants`, { granteeUserId });
      setGrants(await api.get<ResourceGrant[]>(`/v1/documents/${doc.id}/grants`));
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't share with that person. Please try again.");
    } finally {
      setGranting(false);
    }
  }

  async function revokeGrant(grantId: string) {
    await api.post(`/v1/documents/${doc.id}/grants/${grantId}/revoke`);
    setGrants(await api.get<ResourceGrant[]>(`/v1/documents/${doc.id}/grants`));
  }

  async function share() {
    setSharing(true);
    try {
      const result = await api.post<{ url: string }>(`/v1/documents/${doc.id}/share`);
      setShareUrl(result.url);
      setCopied(false);
      // Best-effort — the persistent copy/revoke row below is the real UI either way. Many browsers (most
      // desktop ones, confirmed live via Expo web) have no Web Share API at all and Share.share() throws
      // synchronously there; native iOS/Android always support it, but never let its absence block the flow.
      await Share.share({ message: result.url }).catch(() => undefined);
    } finally {
      setSharing(false);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await Clipboard.setStringAsync(shareUrl);
    setCopied(true);
  }

  async function revokeShare() {
    await api.post(`/v1/documents/${doc.id}/share/revoke`);
    setShareUrl(null);
  }

  async function toggleVisibility(visible: boolean) {
    const next = visible ? "household" : "private";
    await api.post(`/v1/documents/${doc.id}/visibility`, { visibility: next });
    setVisibility(next);
    await onChanged();
  }

  async function applyRetention(policy: string) {
    setSavingRetention(true);
    setError(null);
    try {
      await api.post(`/v1/documents/${doc.id}/retention`, { retentionPolicy: policy });
      setRetentionPolicy(policy);
      setConfirmingRetention(null);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the retention policy. Please try again.");
    } finally {
      setSavingRetention(false);
    }
  }

  useEffect(() => {
    api.get<DocumentVersion[]>(`/v1/documents/${doc.id}/versions`).then(setVersions);
  }, [doc.id]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/documents/${doc.id}`, {
        title,
        documentType,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      await onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteDocument() {
    await api.delete(`/v1/documents/${doc.id}`);
    await onChanged();
  }

  async function replaceFile() {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "image/*", "text/plain"],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    setReplacingFile(true);
    setError(null);
    try {
      await api.upload(
        `/v1/documents/${doc.id}/versions`,
        {},
        { uri: asset.uri, name: asset.name, type: asset.mimeType ?? "application/octet-stream" },
      );
      setVersions(await api.get<DocumentVersion[]>(`/v1/documents/${doc.id}/versions`));
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't upload the new version. Please try again.");
    } finally {
      setReplacingFile(false);
    }
  }

  return (
    <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
      <TextField label="Title" value={title} onChangeText={setTitle} />

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Document type</Text>
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
      </View>

      <TextField label="Tags (comma-separated)" value={tags} onChangeText={setTags} placeholder="kitchen, appliance" />

      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 120 }}>
          <Button onPress={save} loading={saving}>
            Save changes
          </Button>
        </View>
        {!confirmingDelete ? (
          <Button variant="ghost" onPress={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        ) : (
          <>
            <Button variant="critical" onPress={deleteDocument}>
              Confirm delete
            </Button>
            <Button variant="ghost" onPress={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </>
        )}
      </View>

      {doc.householdId && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Visible to household</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Let household members with documents access see this document.</Text>
          </View>
          <Switch value={visibility === "household"} onValueChange={toggleVisibility} trackColor={{ false: theme.colors.borderStrong, true: theme.colors.brandDefault }} />
        </View>
      )}

      {doc.householdId && (
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Share with a household member</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Gives one specific person access to this document, even if it&apos;s private and not visible to the whole household.
          </Text>
          {(() => {
            const activeMembers = members.filter((m) => m.userId && m.status === "active" && m.userId !== user?.id);
            const grantedIds = new Set(grants.map((g) => g.granteeUserId));
            const available = activeMembers.filter((m) => !grantedIds.has(m.userId!));
            return (
              <>
                {available.length > 0 && (
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {available.map((m) => (
                      <Pressable
                        key={m.userId}
                        onPress={() => !granting && m.userId && grantMember(m.userId)}
                        accessibilityRole="button"
                        accessibilityLabel={`Share with ${m.displayName ?? "household member"}`}
                        style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}
                      >
                        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>{m.displayName ?? "Household member"}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
                {grantError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{grantError}</Text>}
                {grants.length > 0 && (
                  <View style={{ gap: 6 }}>
                    {grants.map((g) => {
                      const member = activeMembers.find((m) => m.userId === g.granteeUserId);
                      return (
                        <View
                          key={g.id}
                          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.sm, paddingVertical: 6, paddingHorizontal: 10 }}
                        >
                          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{member?.displayName ?? "Household member"}</Text>
                          <Pressable onPress={() => revokeGrant(g.id)} accessibilityRole="button" accessibilityLabel="Revoke access">
                            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.critical }}>Revoke</Text>
                          </Pressable>
                        </View>
                      );
                    })}
                  </View>
                )}
              </>
            );
          })()}
        </View>
      )}

      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>File retention</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {RETENTION_POLICIES.map((p) => {
            const active = retentionPolicy === p.value;
            const disabled = savingRetention || (retentionPolicy !== "full_original" && retentionPolicy !== p.value);
            return (
              <Text
                key={p.value}
                onPress={() => {
                  if (disabled || active) return;
                  if (p.value === "full_original") applyRetention(p.value);
                  else setConfirmingRetention(p.value);
                }}
                style={{
                  fontSize: 12,
                  fontWeight: "600",
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  borderRadius: theme.radius.full,
                  backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                  color: active ? theme.colors.textOnBrand : disabled ? theme.colors.textTertiary : theme.colors.textSecondary,
                  overflow: "hidden",
                }}
              >
                {p.label}
              </Text>
            );
          })}
        </View>
        {retentionPolicy !== "full_original" && (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            The original file has been deleted; only the extracted text is kept.
          </Text>
        )}
        {confirmingRetention && (
          <Card style={{ gap: 8, backgroundColor: theme.colors.bgSubtle }}>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
              This deletes the original file permanently — it can&rsquo;t be restored. Only the extracted text will remain.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button variant="critical" onPress={() => applyRetention(confirmingRetention)} loading={savingRetention}>
                Delete original
              </Button>
              <Button variant="ghost" onPress={() => setConfirmingRetention(null)}>
                Cancel
              </Button>
            </View>
          </Card>
        )}
      </View>

      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Sharing</Text>
        {!shareUrl ? (
          <Button variant="ghost" onPress={share} loading={sharing}>
            Share
          </Button>
        ) : (
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }} numberOfLines={1}>
              {shareUrl}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={copyShareUrl}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="ghost" onPress={revokeShare}>
                  Revoke
                </Button>
              </View>
            </View>
          </View>
        )}
      </View>

      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Versions</Text>
          <Button variant="ghost" onPress={replaceFile} loading={replacingFile}>
            Upload new version
          </Button>
        </View>
        {versions?.slice().reverse().map((v) => (
          <View key={v.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
              v{v.versionNumber}
              {v.isCurrent && " (current)"}
              {v.diffFromPrevious &&
                !v.diffFromPrevious.unchanged &&
                ` — +${v.diffFromPrevious.linesAdded}/-${v.diffFromPrevious.linesRemoved} lines vs prior`}
              {v.diffFromPrevious?.unchanged && " — no text changes vs prior"}
            </Text>
            <Button variant="ghost" onPress={() => onOpenVersion(doc.id, v.id)}>
              Open
            </Button>
          </View>
        ))}
      </View>
    </View>
  );
}
