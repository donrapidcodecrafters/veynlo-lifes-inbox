"use client";

import { useRef, useState, type FormEvent } from "react";
import useSWR, { useSWRConfig } from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";

interface DocumentRow {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
  createdAt: string;
  householdId: string | null;
  isEmergencyBinderItem: boolean;
  // §40.3 Document state machine's "superseded" — set once this document has been marked as replaced by a
  // newer one (DocumentsService.upload's automatic content-hash path, or the explicit "Mark superseded"
  // action below). Null for every document that isn't currently superseded.
  supersededByDocumentId?: string | null;
  // Resolved server-side (DocumentsService.list) against the FULL document set, not just whatever's in
  // the current filtered `data` page — the replacement document is normally still active, so it's often
  // absent from an "Archived"/"Superseded"-filtered response. Prefer this over cross-referencing `data`.
  supersededByTitle?: string | null;
  // HH-002 "Each object shows a privacy badge: Private, Household, Selected People, Shared Link" — computed
  // server-side (DocumentsService.computeSharingStates) from live resourceGrants/shareLinks/visibility
  // state, not a stored column, so it can never drift out of sync with what's actually shared.
  sharingState?: "private" | "household" | "selected_people" | "shared_link";
}

// §40.3 Document state machine — which processingState bucket `GET /v1/documents?filter=` returns; mirrors
// DocumentsService.list's own doc comment. "Active" (the default) is the everyday vault view; "Archived"/
// "Superseded" are the explicit views a user has to opt into to see a hidden/retired document again.
const DOCUMENT_FILTERS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "superseded", label: "Superseded" },
  { value: "all", label: "All" },
] as const;
type DocumentFilter = (typeof DOCUMENT_FILTERS)[number]["value"];

interface MyHousehold {
  household: { id: string; name: string };
  membership: { id: string };
}

const DOCUMENT_TYPES = [
  { value: "receipt", label: "Receipt" },
  { value: "warranty", label: "Warranty" },
  { value: "insurance_policy", label: "Insurance policy" },
  { value: "contract", label: "Contract" },
  { value: "manual", label: "Manual" },
  { value: "tax_document", label: "Tax document" },
  { value: "registration", label: "Registration" },
  { value: "title", label: "Title" },
  { value: "identity_document", label: "Identity document" },
  { value: "membership_document", label: "Membership" },
  { value: "statement", label: "Statement" },
  { value: "invitation", label: "Invitation" },
  // §27 "Health Logistics" (HLTH-002) — these two default to the "highly_sensitive" tier and always
  // require a fresh password (step-up) to open, even for the owner. See DocumentsService's
  // HEALTH_DOCUMENT_TYPES doc comment and openDocument's handling below.
  { value: "insurance_card", label: "Insurance card" },
  { value: "eob", label: "Explanation of benefits (EOB)" },
  { value: "other", label: "Other" },
];

const HEALTH_DOCUMENT_TYPES = new Set(["insurance_card", "eob"]);

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
  shared_link: "warning", // a live public link is the broadest exposure — worth calling out visually
};

export default function DocumentsPage() {
  const [filter, setFilter] = useState<DocumentFilter>("active");
  const { data, error, isLoading, mutate } = useSWR<DocumentRow[]>(`/v1/documents?filter=${filter}`, swrFetcher);
  const { data: myHouseholds } = useSWR<MyHousehold[]>("/v1/households", swrFetcher);
  // Every state-changing action below (delete, archive/unarchive, supersede, upload, household/binder
  // toggle) can move a document between filter buckets — a plain `mutate()` only revalidates the tab
  // currently on screen, so a sibling tab's SWR cache (e.g. "Active" right after unarchiving from
  // "Archived") stays stale and shows the pre-action state until something else happens to revalidate it.
  // Found live: unarchiving restored the document server-side but the Active tab kept showing "No
  // documents yet" when switched back to within SWR's dedupingInterval. `revalidateAllFilters` fixes that
  // by invalidating every `/v1/documents?filter=*` cache entry, not just the active hook's own key.
  const { mutate: globalMutate } = useSWRConfig();
  function revalidateAllFilters() {
    globalMutate((key) => typeof key === "string" && key.startsWith("/v1/documents?filter="));
  }
  const myHousehold = myHouseholds?.[0] ?? null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Phase 2 §52.2 "bulk management" (spec DSK-004: "tables support multi-select... safe batch actions";
  // "high-risk/destructive batch has preview and count") — DSK-004 is specifically a DESKTOP requirement,
  // and the desktop app is just this web app in a Tauri webview, so web is the right (and only intended)
  // home for it; unlike the Inbox page's bulk confirm/dismiss (justified by a MOBILE spec example, and
  // built on both platforms), there's no mobile-side counterpart to add here. A delete is the one
  // destructive action here, so it's the one that gets a confirm step showing exactly how many and which
  // documents will go.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // Found live: the bulk-delete path above got a confirm-and-count step, but this single-row "Delete"
  // button deleted immediately on one click — no confirmation at all, inconsistent with bulk delete on
  // this very page and with Connections' disconnect-and-delete flow. One misclick on the wrong row had no
  // recovery path in the UI (the delete is soft in the DB, but nothing here lets a user undo it).
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingOne, setDeletingOne] = useState(false);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!data) return;
    setSelectedIds((prev) => (prev.size === data.length ? new Set() : new Set(data.map((d) => d.id))));
  }

  async function deleteOne(id: string) {
    setDeletingOne(true);
    try {
      await api.delete(`/v1/documents/${id}`);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setConfirmingDeleteId(null);
      revalidateAllFilters();
    } finally {
      setDeletingOne(false);
    }
  }

  async function confirmBulkDelete() {
    setBulkDeleting(true);
    try {
      await api.post("/v1/documents/bulk/delete", { ids: [...selectedIds] });
      setSelectedIds(new Set());
      setConfirmingBulkDelete(false);
      revalidateAllFilters();
    } finally {
      setBulkDeleting(false);
    }
  }

  async function toggleHousehold(doc: DocumentRow) {
    if (!myHousehold) return;
    await api.put(`/v1/documents/${doc.id}/household`, { householdId: doc.householdId ? null : myHousehold.household.id });
    revalidateAllFilters();
  }

  async function toggleBinder(doc: DocumentRow) {
    await api.put(`/v1/documents/${doc.id}/emergency-binder`, { isEmergencyBinderItem: !doc.isEmergencyBinderItem });
    revalidateAllFilters();
  }

  // §40.3 Document state machine's "verified"/"archived" — the two single-click user actions this vault
  // never had. Both are idempotent server-side (DocumentsService.verify/archive), so no confirm step is
  // needed the way delete gets one — neither is destructive, and archive has an immediate "Unarchive"
  // undo right on the same row.
  const [stateActionId, setStateActionId] = useState<string | null>(null);
  const [stateActionError, setStateActionError] = useState<string | null>(null);
  const [supersedingId, setSupersedingId] = useState<string | null>(null);
  const [supersedeTargetId, setSupersedeTargetId] = useState<string>("");

  async function runStateAction(id: string, action: "verify" | "archive" | "unarchive") {
    setStateActionId(id);
    setStateActionError(null);
    try {
      await api.put(`/v1/documents/${id}/${action}`);
      revalidateAllFilters();
    } catch (err) {
      setStateActionError(err instanceof ApiError ? err.message : `Couldn't ${action} this document. Please try again.`);
    } finally {
      setStateActionId(null);
    }
  }

  /**
   * §40.3 "superseded" (explicit path) — DocumentsService.markSuperseded is precision-gated (same
   * documentType, an overlapping linked record, or a shared source event) rather than a free-text id
   * lookup, so this picker only ever offers OTHER documents already visible to the user in this same list,
   * not an arbitrary id typed blind.
   */
  async function confirmSupersede(oldId: string) {
    if (!supersedeTargetId) return;
    setStateActionId(oldId);
    setStateActionError(null);
    try {
      await api.put(`/v1/documents/${oldId}/supersede`, { replacedByDocumentId: supersedeTargetId });
      setSupersedingId(null);
      setSupersedeTargetId("");
      revalidateAllFilters();
    } catch (err) {
      setStateActionError(err instanceof ApiError ? err.message : "These documents don't look related enough to link as a replacement.");
    } finally {
      setStateActionId(null);
    }
  }

  const [documentType, setDocumentType] = useState("receipt");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // CAP-007 "Desktop Drag/Drop" — the desktop app is this same web app in a Tauri webview (no separate
  // native drop target of its own; see apps/desktop/src-tauri), so a real HTML5 drop zone here is the
  // actual, only implementation surface for that requirement, not just a web nicety.
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounter = useRef(0);
  const [dropProgress, setDropProgress] = useState<{ done: number; total: number } | null>(null);

  /** Shared by both the file picker (single file) and drag/drop (batch) — spec: "supports batch progress
   * and duplicate warnings." Uploads sequentially rather than in parallel so `dropProgress` reflects real
   * completed-count, and so one huge file doesn't starve the rest of a batch's bandwidth. Duplicate-hash
   * detection already happens server-side per file (DocumentsService) — each file's own success/failure is
   * surfaced, so one bad file in a batch doesn't hide the others' results. */
  async function uploadFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    setDropProgress({ done: 0, total: files.length });
    const errors: string[] = [];
    for (const file of files) {
      try {
        // Field order matters here: @fastify/multipart's request.file() only captures fields that
        // arrive BEFORE the file part in the multipart stream, so the file must be appended last.
        const formData = new FormData();
        formData.append("title", file.name);
        formData.append("documentType", documentType);
        formData.append("file", file);
        await api.upload("/v1/documents/upload", formData);
      } catch (err) {
        errors.push(`${file.name}: ${err instanceof ApiError ? err.message : "Upload failed."}`);
      } finally {
        setDropProgress((prev) => (prev ? { done: prev.done + 1, total: prev.total } : prev));
      }
    }
    if (errors.length > 0) setUploadError(errors.join(" "));
    setUploading(false);
    setDropProgress(null);
    revalidateAllFilters();
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) await uploadFiles([file]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    if (!e.dataTransfer.types.includes("Files")) return;
    dragCounter.current += 1;
    setIsDraggingOver(true);
  }

  function onDragOver(e: React.DragEvent) {
    // Required for onDrop to fire at all — browsers reject a drop on any element whose dragover handler
    // doesn't call preventDefault(), treating it as "not a valid drop target."
    e.preventDefault();
  }

  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) setIsDraggingOver(false);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    await uploadFiles(files);
  }

  async function openDocument(id: string, documentType: string) {
    // HLTH-002 — a health-tagged document always requires a fresh step-up password, even for the owner
    // (HealthLogisticsService.openHealthDocument), so this can't just hit the ordinary download-url route.
    if (HEALTH_DOCUMENT_TYPES.has(documentType)) {
      const password = window.prompt("Re-enter your password to open this health document.");
      if (!password) return;
      try {
        const { url } = await api.post<{ url: string }>(`/v1/health/documents/${id}/unlock`, { password });
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (err) {
        window.alert(err instanceof ApiError ? err.message : "Couldn't unlock that document.");
      }
      return;
    }
    const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div
      className="relative space-y-6"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDraggingOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-surface/90 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-brand bg-surface px-8 py-6 text-center shadow-lg">
            <p className="text-lg font-semibold text-primary">Drop to upload</p>
            <p className="mt-1 text-sm text-tertiary">
              Will be saved as <span className="font-medium text-secondary">{DOCUMENT_TYPES.find((t) => t.value === documentType)?.label}</span> — private to you
            </p>
          </div>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Documents</h1>
          <p className="mt-1 text-sm text-tertiary">
            Receipts, warranties, manuals, and anything else worth keeping — or drag files in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value)}
            aria-label="Document type"
            className="h-10 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
          >
            {DOCUMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <Button onClick={() => fileInputRef.current?.click()} loading={uploading}>
            {dropProgress ? `Uploading ${dropProgress.done}/${dropProgress.total}…` : "Upload"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/heic,text/plain"
            className="hidden"
            onChange={handleFileSelected}
          />
        </div>
      </header>

      {/* §40.3 Document state machine — "Active" is the default; "Archived"/"Superseded" surface documents
          hidden from the default vault view (DocumentsService.list's `filter` param) without leaving them
          unreachable. */}
      <div role="tablist" aria-label="Filter documents" className="flex flex-wrap gap-2">
        {DOCUMENT_FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              filter === f.value ? "bg-brand text-on-brand" : "bg-subtle text-secondary hover:text-primary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {uploadError && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {uploadError}
        </p>
      )}

      {stateActionError && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {stateActionError}
        </p>
      )}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && error && !data && (
        <FetchError what="your documents" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !error && data?.length === 0 && (
        <EmptyState
          title="No documents yet"
          description="Upload a receipt, warranty card, or manual and Veynlo will read the text automatically so you can search it later."
        />
      )}

      {data && data.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-subtle px-3 py-2">
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                checked={selectedIds.size > 0 && selectedIds.size === data.length}
                onChange={toggleSelectAll}
              />
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
            </label>
            {selectedIds.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmingBulkDelete(true)}>
                Delete selected
              </Button>
            )}
          </div>

          {confirmingBulkDelete && (
            <div className="space-y-3 rounded-lg border border-critical/40 bg-critical-subtle p-3">
              <p className="text-sm text-critical-subtle-text">
                Delete {selectedIds.size} document{selectedIds.size === 1 ? "" : "s"}? This can&apos;t be undone.
              </p>
              <div className="flex gap-2">
                <Button size="sm" loading={bulkDeleting} onClick={confirmBulkDelete}>
                  Confirm delete
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingBulkDelete(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <ul className="space-y-2">
          {data.map((doc) => (
            <li key={doc.id}>
              <Card>
                <CardBody className="flex flex-col gap-2 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex min-w-[180px] flex-1 items-center gap-3">
                      <input type="checkbox" checked={selectedIds.has(doc.id)} onChange={() => toggleSelected(doc.id)} aria-label={`Select ${doc.title}`} />
                      <div className="min-w-0">
                        {/* `truncate` clips long titles with no way to recover the rest — a real long
                            filename (tested with a 150+ char name) reads as just "xxxxxxx…" with nothing
                            to confirm which file it actually is. `title` gives it a native hover tooltip,
                            same pattern already used for the truncated grantee email in
                            share-resource-panel.tsx. */}
                        <p className="truncate text-sm font-medium text-primary" title={doc.title}>{doc.title}</p>
                        <p className="text-xs capitalize text-tertiary">{doc.documentType.replace(/_/g, " ")}</p>
                      </div>
                    </div>
                    {/* Found live (Group B audit): at 390px, a document with a "Household" privacy badge (longer
                        than "Private") pushed this row's 2 badges + 3 buttons past 372px while its available
                        width was only ~324px — this row had no wrap of its own, unlike the outer row, so it
                        overflowed the card and the whole page horizontally instead of dropping buttons to a
                        second line (same bug class already fixed on Connections' connector-card row). */}
                    <div className="flex flex-wrap items-center gap-3">
                      <Badge tone={PRIVACY_TONE[doc.sharingState ?? "private"]}>{PRIVACY_LABEL[doc.sharingState ?? "private"]}</Badge>
                      <Badge tone={STATE_TONE[doc.processingState] ?? "neutral"}>
                        {doc.processingState.replace(/_/g, " ")}
                      </Badge>
                      <Button size="sm" variant="ghost" onClick={() => openDocument(doc.id, doc.documentType)}>
                        {HEALTH_DOCUMENT_TYPES.has(doc.documentType) ? "Unlock & open" : "Open"}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setSharingId(sharingId === doc.id ? null : doc.id)}>
                        Share
                      </Button>
                      {/* §40.3 "verified" (DEC-001 "confirm/correct state") — only offered once the pipeline
                          has produced something to confirm (classified/extracted/linked); already-verified,
                          archived, superseded, and deleted documents don't get this button. */}
                      {["classified", "extracted", "linked"].includes(doc.processingState) && (
                        <Button size="sm" variant="ghost" loading={stateActionId === doc.id} onClick={() => runStateAction(doc.id, "verify")}>
                          Confirm correct
                        </Button>
                      )}
                      {/* §40.3 "archived" — a soft-hide distinct from delete; the document stays in the vault
                          and is still reachable via the "Archived" filter above, just out of the default view. */}
                      {doc.processingState === "archived" ? (
                        <Button size="sm" variant="ghost" loading={stateActionId === doc.id} onClick={() => runStateAction(doc.id, "unarchive")}>
                          Unarchive
                        </Button>
                      ) : (
                        doc.processingState !== "deleted" && (
                          <Button size="sm" variant="ghost" loading={stateActionId === doc.id} onClick={() => runStateAction(doc.id, "archive")}>
                            Archive
                          </Button>
                        )
                      )}
                      {/* §40.3 "superseded" (explicit path) — for a replacement whose content differs from
                          the original (upload()'s automatic byte-identical path already handles the exact-
                          duplicate case with no extra step). Precision-gated server-side. */}
                      {doc.processingState !== "deleted" && doc.processingState !== "superseded" && (
                        <Button size="sm" variant="ghost" onClick={() => setSupersedingId(supersedingId === doc.id ? null : doc.id)}>
                          Mark replaced…
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setConfirmingDeleteId(doc.id)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                  {doc.supersededByDocumentId && (
                    <p className="text-xs text-tertiary">
                      Replaced by:{" "}
                      <span className="font-medium text-secondary">
                        {doc.supersededByTitle ?? doc.supersededByDocumentId}
                      </span>
                    </p>
                  )}
                  {supersedingId === doc.id && (
                    <div className="space-y-2 rounded-lg border border-border-subtle bg-subtle p-3">
                      <p className="text-xs text-secondary">Which document replaces &quot;{doc.title}&quot;?</p>
                      <select
                        value={supersedeTargetId}
                        onChange={(e) => setSupersedeTargetId(e.target.value)}
                        aria-label="Replacement document"
                        className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                      >
                        <option value="">Choose a document…</option>
                        {data
                          .filter((d) => d.id !== doc.id)
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.title}
                            </option>
                          ))}
                      </select>
                      <div className="flex gap-2">
                        <Button size="sm" loading={stateActionId === doc.id} disabled={!supersedeTargetId} onClick={() => confirmSupersede(doc.id)}>
                          Confirm replacement
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setSupersedingId(null);
                            setSupersedeTargetId("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {confirmingDeleteId === doc.id && (
                    <div className="space-y-2 rounded-lg border border-critical/40 bg-critical-subtle p-3">
                      {/* Found live: a document title with no natural word breaks (tested with a 150+
                          char filename — the row's own truncated title above handles this fine, but this
                          confirmation text interpolates the raw title with nothing to stop it) rendered as
                          one unbroken line that pushed this box, its card, and the whole page well past
                          the viewport's right edge instead of wrapping. `break-words` lets the browser
                          break inside the title itself once it's the only way to avoid overflowing. */}
                      <p className="break-words text-xs text-critical-subtle-text">
                        Delete &quot;{doc.title}&quot;? This can&apos;t be undone.
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" loading={deletingOne} onClick={() => deleteOne(doc.id)}>
                          Confirm delete
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmingDeleteId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                  {myHousehold && (
                    <div className="flex items-center gap-3 border-t border-border-subtle pt-2 text-xs">
                      <button onClick={() => toggleHousehold(doc)} className="font-medium text-brand hover:underline">
                        {doc.householdId ? `Shared with ${myHousehold.household.name}` : `Share with ${myHousehold.household.name}`}
                      </button>
                      {doc.householdId && (
                        <button onClick={() => toggleBinder(doc)} className="font-medium text-brand hover:underline">
                          {doc.isEmergencyBinderItem ? "Remove from emergency binder" : "Add to emergency binder"}
                        </button>
                      )}
                    </div>
                  )}
                  {sharingId === doc.id && <ShareResourcePanel resourceId={doc.id} collectionPath="/v1/documents" resourceLabel="document" />}
                </CardBody>
              </Card>
            </li>
          ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ShareDocumentPanel used to live here as a document-only component; it's now the generic
// ShareResourcePanel (@/components/sharing/share-resource-panel), parameterized by resourceType/
// resourceId so lists/purchases/properties/vehicles can reuse the exact same UI — see that component's
// own doc comment.
