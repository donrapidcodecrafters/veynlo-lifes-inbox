"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
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
}

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

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      // Field order matters here: @fastify/multipart's request.file() only captures fields that
      // arrive BEFORE the file part in the multipart stream, so the file must be appended last.
      const formData = new FormData();
      formData.append("title", file.name);
      formData.append("documentType", documentType);
      formData.append("file", file);
      await api.upload("/v1/documents/upload", formData);
      mutate();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function openDocument(id: string, versionId?: string) {
    const query = versionId ? `?versionId=${versionId}` : "";
    const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url${query}`);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Documents</h1>
          <p className="mt-1 text-sm text-tertiary">Receipts, warranties, manuals, and anything else worth keeping.</p>
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

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((doc) => (
            <li key={doc.id}>
              <Card>
                <CardBody className="space-y-3 py-3">
                  <div className="flex items-center justify-between gap-4">
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
