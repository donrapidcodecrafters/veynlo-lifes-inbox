"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

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

/** TIME-002 "Object history" — a generic section reused across every detail page: notes, attached documents, and (only where the backend actually composes it — currently purchases) directly related records. "Compare versions" isn't offered — there's no revision table behind any of these domains yet. */
export function HistorySection({
  resourceType,
  resourceId,
  showRelatedKinds,
}: {
  resourceType: string;
  resourceId: string;
  /** Restricts which `related` kinds this instance renders — lets the purchase page show only warranties here, since shipments/returns already have their own dedicated cards on that page. */
  showRelatedKinds?: RelatedItem["kind"][];
}) {
  const { data, mutate } = useSWR<HistoryResponse>(`/v1/history/${resourceType}/${resourceId}`, swrFetcher);
  const [noteText, setNoteText] = useState("");
  const [submittingNote, setSubmittingNote] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function addNote() {
    if (!noteText.trim()) return;
    setSubmittingNote(true);
    try {
      await api.post(`/v1/history/${resourceType}/${resourceId}/notes`, { noteText });
      setNoteText("");
      mutate();
    } finally {
      setSubmittingNote(false);
    }
  }

  async function attachDocument(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("documentType", "other");
      formData.append("title", file.name);
      formData.append("linkedResourceId", resourceId);
      formData.append("file", file);
      await api.upload("/v1/documents/upload", formData);
      mutate();
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  const related = data?.related.filter((r) => !showRelatedKinds || showRelatedKinds.includes(r.kind)) ?? [];

  return (
    <Card>
      <CardBody className="space-y-4">
        <p className="text-sm font-medium text-primary">History</p>

        {related.length > 0 && (
          <div className="space-y-1">
            {related.map((r) => (
              <p key={`${r.kind}-${r.id}`} className="text-sm text-secondary">
                {RELATED_LABEL[r.kind]} — {r.label}
              </p>
            ))}
          </div>
        )}

        <div className="space-y-2 border-t border-border-subtle pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Documents</p>
          {data?.documents.length === 0 && <p className="text-sm text-tertiary">No documents attached yet.</p>}
          {data?.documents.map((d) => (
            <Link key={d.id} href="/documents" className="block text-sm text-brand hover:underline">
              {d.title}
            </Link>
          ))}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attachDocument(file);
            }}
          />
          <Button size="sm" variant="secondary" loading={uploading} onClick={() => fileInputRef.current?.click()}>
            Attach document
          </Button>
        </div>

        <div className="space-y-2 border-t border-border-subtle pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Notes</p>
          {data?.notes.length === 0 && <p className="text-sm text-tertiary">No notes yet.</p>}
          {data?.notes.map((n) => (
            <div key={n.id} className="rounded-lg bg-subtle p-2">
              <p className="text-sm text-primary">{n.noteText}</p>
              <p className="mt-0.5 text-xs text-tertiary">{new Date(n.createdAt).toLocaleString()}</p>
            </div>
          ))}
          <Textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note…"
            rows={2}
          />
          <Button size="sm" variant="secondary" loading={submittingNote} onClick={addNote} disabled={!noteText.trim()}>
            Add note
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
