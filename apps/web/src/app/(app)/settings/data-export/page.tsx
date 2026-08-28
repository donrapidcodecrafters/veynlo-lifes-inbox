"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

interface ExportJob {
  id: string;
  state: "queued" | "processing" | "completed" | "failed";
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
}

const STATE_TONE: Record<ExportJob["state"], "positive" | "warning" | "critical" | "neutral"> = {
  completed: "positive",
  processing: "neutral",
  queued: "neutral",
  failed: "critical",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function DataExportPage() {
  const { data, isLoading, mutate } = useSWR<ExportJob[]>("/v1/data-export", swrFetcher, {
    refreshInterval: (latest) => (latest?.some((j) => j.state === "queued" || j.state === "processing") ? 3000 : 0),
  });
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  async function requestExport() {
    setRequesting(true);
    setError(null);
    try {
      await api.post("/v1/data-export");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start the export. Please try again.");
    } finally {
      setRequesting(false);
    }
  }

  async function download(jobId: string) {
    setDownloadingId(jobId);
    setError(null);
    try {
      const { url } = await api.get<{ url: string }>(`/v1/data-export/${jobId}/download-url`);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get a download link. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Export your data</h1>
        <p className="mt-1 text-sm text-tertiary">
          Download a copy of everything Veynlo has recorded for you — purchases, bills, warranties,
          subscriptions, calendar events, tasks, and more, as a single file.
        </p>
      </header>

      <Card>
        <CardBody className="flex items-center justify-between gap-3">
          <p className="text-sm text-tertiary">A new export reflects your data as of the moment you request it.</p>
          <Button onClick={requestExport} loading={requesting}>
            Request export
          </Button>
        </CardBody>
      </Card>

      {error && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {error}
        </p>
      )}

      {!isLoading && data?.length === 0 && (
        <EmptyState title="No exports yet" description="Request one above — it usually takes just a moment." />
      )}

      {data && data.length > 0 && (
        <ul className="space-y-3">
          {data.map((job) => (
            <li key={job.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
                    <p className="text-sm text-tertiary">
                      Requested {formatWhen(job.requestedAt)}
                      {job.completedAt ? ` · Ready ${formatWhen(job.completedAt)}` : ""}
                      {job.expiresAt ? ` · Available until ${formatWhen(job.expiresAt)}` : ""}
                    </p>
                    {job.state === "failed" && job.errorMessage && (
                      <p className="text-sm text-critical">{job.errorMessage}</p>
                    )}
                  </div>
                  {job.state === "completed" && (
                    <Button variant="secondary" size="sm" onClick={() => download(job.id)} loading={downloadingId === job.id}>
                      Download
                    </Button>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
