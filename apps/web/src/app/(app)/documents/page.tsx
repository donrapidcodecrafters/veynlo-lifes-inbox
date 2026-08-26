"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface DocumentRow {
  id: string;
  title: string;
  documentType: string;
  processingState: string;
  createdAt: string;
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

  async function openDocument(id: string) {
    const { url } = await api.get<{ url: string }>(`/v1/documents/${id}/download-url`);
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
                <CardBody className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-primary">{doc.title}</p>
                    <p className="text-xs capitalize text-tertiary">{doc.documentType.replace(/_/g, " ")}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge tone={STATE_TONE[doc.processingState] ?? "neutral"}>
                      {doc.processingState.replace(/_/g, " ")}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={() => openDocument(doc.id)}>
                      Open
                    </Button>
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
