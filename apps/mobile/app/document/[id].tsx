import { useCallback, useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { FetchError } from "@/components/fetch-error";
import { TextField } from "@/components/text-field";

interface DocumentDetail {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
  // §40.3 Document state machine's "verified"/"superseded" — see DocumentsService.documentDetail's own
  // doc comment for how `replaces`/`supersededByDocumentId` are computed.
  verifiedAt: string | null;
  supersededByDocumentId: string | null;
  replaces: { id: string; title: string }[];
  isEmergencyBinderItem: boolean;
  householdId: string | null;
  createdAt: string;
  sharingState: "private" | "household" | "selected_people" | "shared_link";
  version: {
    mimeType: string;
    sizeBytes: number;
    ocrText: string | null;
    ocrConfidence: number | null;
  } | null;
}

interface DocumentListRow {
  id: string;
  title: string;
}

// Mirrors documents.tsx's own STATE_TONE/PRIVACY_LABEL/PRIVACY_TONE maps. Not imported from there — every
// other `[id].tsx` detail screen in this app (warranty/[id].tsx, entity/[id].tsx) is self-contained and
// doesn't reach back into its list screen for shared constants, so this follows the same convention rather
// than introducing the first cross-file dependency of that shape.
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

const PRIVACY_LABEL: Record<DocumentDetail["sharingState"], string> = {
  private: "Private",
  household: "Household",
  selected_people: "Selected people",
  shared_link: "Shared link",
};

const PRIVACY_TONE: Record<DocumentDetail["sharingState"], "neutral" | "warning" | "positive"> = {
  private: "neutral",
  household: "positive",
  selected_people: "positive",
  shared_link: "warning",
};

// HLTH-002 — these two default to the "highly_sensitive" tier and always require a fresh password
// (step-up) to open, even for the owner. Mirrors apps/web's documents/page.tsx HEALTH_DOCUMENT_TYPES and
// documents.tsx's own copy of this set (kept as a plain literal here rather than imported — see this
// file's own doc comment above on why detail screens in this app stay self-contained). This screen was
// missing the gate entirely (confirmed live: it called the ordinary /v1/documents/:id/download-url route
// for every documentType) — health-appointment/[id].tsx's DocumentsPanel already has the mobile-side
// pattern for the POST /v1/health/documents/:id/unlock step-up flow this reuses.
const HEALTH_DOCUMENT_TYPES = new Set(["insurance_card", "eob"]);

export default function DocumentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<DocumentDetail | null | undefined>(undefined);
  // Same class of bug fixed elsewhere in this app (documents.tsx, warranty/[id].tsx, entity/[id].tsx): an
  // unguarded fetch becomes an unhandled promise rejection on any transient network failure, which React
  // Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just
  // this screen. Caught into loadError instead.
  //
  // Also same class of bug as property/[id].tsx and vehicle/[id].tsx (see their own doc comments):
  // `GET /v1/documents/:id` responds with a real 404 HTTP status for a missing/inaccessible document
  // (documents.service.ts throws DocumentNotFoundException, not a 200 with a `null` body the way
  // bill/warranty/purchase detail do), so a bogus id rejected straight into the generic `loadError`
  // branch below ("Something went wrong") — the friendlier `data === null` → "Not found" EmptyState a
  // few lines down was dead code for every bogus/forbidden document id (confirmed live via Playwright:
  // GET /v1/documents/does-not-exist -> 404 DOCUMENT_NOT_FOUND). A 404 is now mapped back to
  // `setData(null)` so that branch actually renders; a genuine network/server error still surfaces as
  // the inline loadError message.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // HLTH-002 step-up — mirrors identity-record/[id].tsx's RevealDocumentNumberPanel and
  // health-appointment/[id].tsx's DocumentsPanel: try with no password first (a no-op for the ordinary
  // download-url path below), only prompt when the server actually asks (PASSWORD_REQUIRED).
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [retrying, setRetrying] = useState(false);
  // §40.3 Document state machine's "verified"/"archived"/"superseded" — see DocumentsService's own doc
  // comments on verify/archive/unarchive/markSuperseded for what each action does and guards against.
  const [stateActionLoading, setStateActionLoading] = useState(false);
  const [stateActionError, setStateActionError] = useState<string | null>(null);
  const [supersedeCandidates, setSupersedeCandidates] = useState<DocumentListRow[] | null>(null);
  const [supersedeTargetId, setSupersedeTargetId] = useState<string>("");
  const [showSupersedePicker, setShowSupersedePicker] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<DocumentDetail | null>(`/v1/documents/${id}`));
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setData(null);
        setLoadError(null);
      } else {
        setLoadError(err instanceof ApiError ? err.message : "Couldn't load this document. Please try again.");
      }
    } finally {
      setRetrying(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function openDocument(withPassword?: string) {
    setOpening(true);
    setOpenError(null);
    try {
      // HLTH-002 — a health-tagged document always requires a fresh step-up password, even for the owner
      // (HealthLogisticsService.openHealthDocument), so this can't just hit the ordinary download-url
      // route. Mirrors apps/web's documents/page.tsx openDocument exactly.
      if (data && HEALTH_DOCUMENT_TYPES.has(data.documentType)) {
        const { url } = await api.post<{ url: string }>(`/v1/health/documents/${id}/unlock`, { password: withPassword });
        setPasswordPromptOpen(false);
        setPassword("");
        await Linking.openURL(url);
        return;
      }
      const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
      await Linking.openURL(url);
    } catch (err) {
      if (data && HEALTH_DOCUMENT_TYPES.has(data.documentType) && err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptOpen(true);
        return;
      }
      setOpenError(err instanceof ApiError ? err.message : "Couldn't open the original file. Please try again.");
    } finally {
      setOpening(false);
    }
  }

  async function runStateAction(action: "verify" | "archive" | "unarchive") {
    setStateActionLoading(true);
    setStateActionError(null);
    try {
      await api.put(`/v1/documents/${id}/${action}`);
      await load();
    } catch (err) {
      setStateActionError(err instanceof ApiError ? err.message : `Couldn't ${action} this document. Please try again.`);
    } finally {
      setStateActionLoading(false);
    }
  }

  /** Loads the picker's candidate list lazily — the full vault list, not just this screen's own document —
   * mirroring apps/web's inline `<select>`; DocumentsService.markSuperseded's own precision guard (same
   * documentType, an overlapping domain link, or a shared source event) is what actually decides whether a
   * chosen pair is confidently related, so this list is deliberately unfiltered. */
  async function openSupersedePicker() {
    setShowSupersedePicker(true);
    if (supersedeCandidates) return;
    try {
      const all = await api.get<DocumentListRow[]>("/v1/documents?filter=active");
      setSupersedeCandidates(all.filter((d) => d.id !== id));
    } catch {
      setSupersedeCandidates([]);
    }
  }

  async function confirmSupersede() {
    if (!supersedeTargetId) return;
    setStateActionLoading(true);
    setStateActionError(null);
    try {
      await api.put(`/v1/documents/${id}/supersede`, { replacedByDocumentId: supersedeTargetId });
      setShowSupersedePicker(false);
      setSupersedeTargetId("");
      await load();
    } catch (err) {
      setStateActionError(err instanceof ApiError ? err.message : "These documents don't look related enough to link as a replacement.");
    } finally {
      setStateActionLoading(false);
    }
  }

  if (loadError) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={loadError}
          what="this document"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) {
    return (
      <Screen>
        <View style={{ height: 160, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This document doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const ocrText = data.version?.ocrText?.trim() || null;

  return (
    <Screen>
      <ScreenHeader title={data.title} subtitle={data.documentType.replace(/_/g, " ")} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Badge tone={PRIVACY_TONE[data.sharingState]}>{PRIVACY_LABEL[data.sharingState]}</Badge>
        <Badge tone={STATE_TONE[data.processingState] ?? "neutral"}>{data.processingState.replace(/_/g, " ")}</Badge>
        {data.isEmergencyBinderItem && <Badge tone="warning">Emergency binder</Badge>}
      </View>

      {data.supersededByDocumentId && (
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>This document has been replaced by a newer one.</Text>
      )}
      {data.replaces.length > 0 && (
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
          Replaces: {data.replaces.map((r) => r.title).join(", ")}
        </Text>
      )}

      {openError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{openError}</Text>}
      <Button variant="secondary" onPress={() => openDocument()} loading={opening}>
        {HEALTH_DOCUMENT_TYPES.has(data.documentType) ? "Unlock & open original file" : "Open original file"}
      </Button>
      {/* HLTH-002 step-up — same password-prompt shape as identity-record/[id].tsx's
          RevealDocumentNumberPanel and health-appointment/[id].tsx's DocumentsPanel. */}
      {passwordPromptOpen && (
        <View style={{ gap: 8 }}>
          <TextField
            label="Confirm your password to open this"
            secureTextEntry
            autoComplete="current-password"
            value={password}
            onChangeText={setPassword}
            autoFocus
          />
          <Button onPress={() => openDocument(password)} loading={opening}>
            Unlock
          </Button>
        </View>
      )}

      {stateActionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{stateActionError}</Text>}

      {/* §40.3 "verified"/"archived"/"superseded" — the three user-triggered actions this screen adds.
          "Confirm correct" is only offered once the pipeline has produced something to confirm; already-
          verified/archived/superseded/deleted documents don't get it. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {["classified", "extracted", "linked"].includes(data.processingState) && (
          <Button variant="ghost" onPress={() => runStateAction("verify")} loading={stateActionLoading}>
            Confirm correct
          </Button>
        )}
        {data.processingState !== "deleted" && (
          <Button variant="ghost" onPress={() => runStateAction(data.processingState === "archived" ? "unarchive" : "archive")} loading={stateActionLoading}>
            {data.processingState === "archived" ? "Unarchive" : "Archive"}
          </Button>
        )}
        {data.processingState !== "deleted" && data.processingState !== "superseded" && (
          <Button variant="ghost" onPress={openSupersedePicker} loading={stateActionLoading}>
            Mark replaced…
          </Button>
        )}
      </View>

      {showSupersedePicker && (
        <Card style={{ gap: 10 }}>
          {/* Mirrors apps/web's documents/page.tsx exactly: "Which document replaces &quot;{doc.title}&quot;?"
              — this previously read the generic "Which document replaces this one?" here, which doesn't
              say which document it means when more than one supersede picker could plausibly be open. */}
          <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Which document replaces &quot;{data.title}&quot;?</Text>
          {supersedeCandidates === null ? (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading your documents…</Text>
          ) : supersedeCandidates.length === 0 ? (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No other documents to choose from.</Text>
          ) : (
            <View style={{ gap: 6 }}>
              {supersedeCandidates.map((c) => (
                <Text
                  key={c.id}
                  accessibilityRole="button"
                  onPress={() => setSupersedeTargetId(c.id)}
                  numberOfLines={1}
                  style={{
                    fontSize: 13,
                    padding: 8,
                    borderRadius: theme.radius.md,
                    backgroundColor: supersedeTargetId === c.id ? theme.colors.brandDefault : theme.colors.bgSubtle,
                    color: supersedeTargetId === c.id ? theme.colors.textOnBrand : theme.colors.textPrimary,
                  }}
                >
                  {c.title}
                </Text>
              ))}
            </View>
          )}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button onPress={confirmSupersede} loading={stateActionLoading} disabled={!supersedeTargetId}>
              Confirm replacement
            </Button>
            <Button
              variant="ghost"
              onPress={() => {
                setShowSupersedePicker(false);
                setSupersedeTargetId("");
              }}
            >
              Cancel
            </Button>
          </View>
        </Card>
      )}

      <Card style={{ gap: 10 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Extracted text</Text>
        {ocrText ? (
          <View
            style={{
              backgroundColor: theme.colors.bgSubtle,
              borderRadius: theme.radius.md,
              padding: 12,
            }}
          >
            <Text
              selectable
              style={{ fontSize: 13, lineHeight: 19, color: theme.colors.textPrimary, fontFamily: "monospace" }}
            >
              {ocrText}
            </Text>
          </View>
        ) : (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            No extracted text yet. Veynlo hasn&apos;t read this document's contents — it may still be processing, or text
            extraction found nothing to show.
          </Text>
        )}
        {data.version?.ocrConfidence != null && ocrText && (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Confidence: {Math.round(data.version.ocrConfidence * 100)}%
          </Text>
        )}
      </Card>
    </Screen>
  );
}
