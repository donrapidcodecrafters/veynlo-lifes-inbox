"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { swrFetcher, api, API_BASE_URL, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

interface DocumentRow {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
  tags: string[];
  createdAt: string;
  retentionPolicy: string;
}

const RETENTION_POLICIES = [
  { value: "full_original", label: "Keep original file" },
  { value: "extracted_only", label: "Keep extracted text only" },
  { value: "delete_after_processing", label: "Delete original after processing" },
] as const;

interface DocumentVersion {
  id: string;
  versionNumber: number;
  sizeBytes: number;
  mimeType: string;
  ocrText: string | null;
  createdAt: string;
  isCurrent: boolean;
  diffFromPrevious: { linesAdded: number; linesRemoved: number; unchanged: boolean } | null;
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

export default function DocumentsPage() {
  const { data, isLoading, mutate } = useSWR<DocumentRow[]>("/v1/documents", swrFetcher);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documentType, setDocumentType] = useState("receipt");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingDuplicate, setPendingDuplicate] = useState<{ file: File; duplicateOfTitle: string } | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragDepth = useRef(0);
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

  /** DOC-007 "export packet" — a POST with a body can't use a plain link/redirect like the timeline's CSV
   * export does, so the ZIP arrives as a blob and gets handed to the browser via a throwaway object URL. */
  async function exportSelected() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/v1/documents/export`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "x-veynlo-platform": "web" },
        body: JSON.stringify({ documentIds: Array.from(selectedIds) }),
      });
      if (!res.ok) throw new Error("Export failed.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `veynlo-documents-${new Date().toISOString().slice(0, 10)}.zip`;
      link.click();
      URL.revokeObjectURL(url);
      setSelectedIds(new Set());
    } catch {
      setExportError("Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  async function performUpload(file: File, force: boolean) {
    setUploading(true);
    setUploadError(null);
    try {
      // Field order matters here: @fastify/multipart's request.file() only captures fields that
      // arrive BEFORE the file part in the multipart stream, so the file must be appended last.
      const formData = new FormData();
      formData.append("title", file.name);
      formData.append("documentType", documentType);
      if (force) formData.append("force", "true");
      formData.append("file", file);
      const result = await api.upload<{ documentId: string; duplicate?: true; duplicateOfTitle?: string }>(
        "/v1/documents/upload",
        formData,
      );
      if (result.duplicate) {
        setPendingDuplicate({ file, duplicateOfTitle: result.duplicateOfTitle ?? "an existing document" });
      } else {
        setPendingDuplicate(null);
        mutate();
      }
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await performUpload(file, false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /**
   * §CAP-007 "Desktop drag/drop" — apps/desktop is a Tauri webview wrapping this exact web app (no
   * separate desktop UI), so a plain DOM drag-and-drop zone here covers desktop capture too without any
   * Rust-side file-drop handling. Depth-counted enter/leave (rather than a naive boolean) because a drag
   * over child elements fires dragenter/dragleave on each one, which would otherwise flicker the overlay.
   */
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current += 1;
    setIsDraggingOver(true);
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDraggingOver(false);
    }
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDraggingOver(false);
    const file = e.dataTransfer.files[0];
    if (file) await performUpload(file, false);
  }

  async function openDocument(id: string, versionId?: string) {
    const query = versionId ? `?versionId=${versionId}` : "";
    const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url${query}`);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div
      className="relative space-y-6"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {isDraggingOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center border-4 border-dashed border-brand bg-surface/90">
          <p className="text-lg font-semibold text-primary">Drop to upload</p>
        </div>
      )}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Documents</h1>
          <p className="mt-1 text-sm text-tertiary">Receipts, warranties, manuals, and anything else worth keeping.</p>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <Button size="sm" variant="secondary" onClick={exportSelected} loading={exporting}>
              Export selected ({selectedIds.size})
            </Button>
          )}
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
            Upload
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

      {uploadError && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {uploadError}
        </p>
      )}

      {pendingDuplicate && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warning-subtle px-3 py-2">
          <p className="text-sm text-warning-subtle-text">
            You already have &ldquo;{pendingDuplicate.duplicateOfTitle}&rdquo; — this looks like the same file.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => performUpload(pendingDuplicate.file, true)} loading={uploading}>
              Upload anyway
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPendingDuplicate(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && data?.length === 0 && (
        <EmptyState
          title="No documents yet"
          description="Upload a receipt, warranty card, or manual and Veynlo will read the text automatically so you can search it later."
        />
      )}

      {exportError && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {exportError}
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((doc) => (
            <li key={doc.id}>
              <Card>
                <CardBody className="space-y-3 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <input
                      type="checkbox"
                      aria-label={`Select ${doc.title} for export`}
                      checked={selectedIds.has(doc.id)}
                      onChange={() => toggleSelected(doc.id)}
                      className="h-4 w-4 shrink-0 rounded border-border-default"
                    />
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === doc.id ? null : doc.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium text-primary">{doc.title}</p>
                      <p className="text-xs capitalize text-tertiary">
                        {doc.documentType.replace(/_/g, " ")}
                        {doc.tags.length > 0 && ` · ${doc.tags.join(", ")}`}
                      </p>
                    </button>
                    <div className="flex items-center gap-3">
                      <Badge tone={STATE_TONE[doc.processingState] ?? "neutral"}>{doc.processingState.replace(/_/g, " ")}</Badge>
                      <Button size="sm" variant="ghost" onClick={() => openDocument(doc.id)}>
                        Open
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setExpandedId(expandedId === doc.id ? null : doc.id)}>
                        {expandedId === doc.id ? "Close" : "Edit"}
                      </Button>
                    </div>
                  </div>
                  {expandedId === doc.id && <DocumentEditor doc={doc} onChanged={mutate} onOpenVersion={openDocument} />}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentEditor({
  doc,
  onChanged,
  onOpenVersion,
}: {
  doc: DocumentRow;
  onChanged: () => void;
  onOpenVersion: (id: string, versionId?: string) => void;
}) {
  const { data: versions, mutate: mutateVersions } = useSWR<DocumentVersion[]>(`/v1/documents/${doc.id}/versions`, swrFetcher);
  const versionFileInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(doc.title);
  const [documentType, setDocumentType] = useState(doc.documentType);
  const [tags, setTags] = useState(doc.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [replacingFile, setReplacingFile] = useState(false);
  const [retentionPolicy, setRetentionPolicy] = useState(doc.retentionPolicy);
  const [savingRetention, setSavingRetention] = useState(false);
  const [confirmingRetention, setConfirmingRetention] = useState<string | null>(null);

  async function applyRetention(policy: string) {
    setSavingRetention(true);
    setError(null);
    try {
      await api.post(`/v1/documents/${doc.id}/retention`, { retentionPolicy: policy });
      setRetentionPolicy(policy);
      setConfirmingRetention(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the retention policy. Please try again.");
    } finally {
      setSavingRetention(false);
    }
  }

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
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteDocument() {
    await api.delete(`/v1/documents/${doc.id}`);
    onChanged();
  }

  async function handleReplaceFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setReplacingFile(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await api.upload(`/v1/documents/${doc.id}/versions`, formData);
      mutateVersions();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't upload the new version. Please try again.");
    } finally {
      setReplacingFile(false);
      if (versionFileInputRef.current) versionFileInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-4 border-t border-border-subtle pt-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`title-${doc.id}`}>Title</Label>
          <Input id={`title-${doc.id}`} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <Label htmlFor={`type-${doc.id}`}>Document type</Label>
          <select
            id={`type-${doc.id}`}
            value={documentType}
            onChange={(e) => setDocumentType(e.target.value)}
            className="h-10 w-full rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
          >
            {DOCUMENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor={`tags-${doc.id}`}>Tags (comma-separated)</Label>
          <Input id={`tags-${doc.id}`} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="kitchen, appliance" />
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} loading={saving}>
          Save changes
        </Button>
        {!confirmingDelete ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(true)}>
            Delete
          </Button>
        ) : (
          <>
            <Button size="sm" variant="critical" onClick={deleteDocument}>
              Confirm delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </>
        )}
      </div>

      <div className="space-y-2 border-t border-border-subtle pt-3">
        <Label htmlFor={`retention-${doc.id}`}>File retention</Label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id={`retention-${doc.id}`}
            value={retentionPolicy}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "full_original" || next === retentionPolicy) {
                applyRetention(next);
              } else {
                setConfirmingRetention(next);
              }
            }}
            disabled={savingRetention || retentionPolicy !== "full_original"}
            className="h-10 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary disabled:opacity-60"
          >
            {RETENTION_POLICIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {retentionPolicy !== "full_original" && (
            <span className="text-xs text-tertiary">The original file has been deleted; only the extracted text is kept.</span>
          )}
        </div>
        {confirmingRetention && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-warning-subtle px-3 py-2">
            <p className="text-sm text-warning-subtle-text">
              This deletes the original file permanently — it can&rsquo;t be restored. Only the extracted text will remain.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="critical" onClick={() => applyRetention(confirmingRetention)} loading={savingRetention}>
                Delete original
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmingRetention(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-border-subtle pt-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-primary">Versions</p>
          <Button size="sm" variant="ghost" onClick={() => versionFileInputRef.current?.click()} loading={replacingFile}>
            Upload new version
          </Button>
          <input ref={versionFileInputRef} type="file" className="hidden" onChange={handleReplaceFile} />
        </div>
        {versions && versions.length > 0 && (
          <ul className="space-y-1">
            {versions
              .slice()
              .reverse()
              .map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-primary">
                    v{v.versionNumber}
                    {v.isCurrent && " (current)"}
                    {v.diffFromPrevious &&
                      !v.diffFromPrevious.unchanged &&
                      ` — +${v.diffFromPrevious.linesAdded}/-${v.diffFromPrevious.linesRemoved} lines vs prior`}
                    {v.diffFromPrevious?.unchanged && " — no text changes vs prior"}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => onOpenVersion(doc.id, v.id)}>
                    Open
                  </Button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>
  );
}
