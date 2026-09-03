"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/input";
import { FetchError } from "@/components/ui/fetch-error";

interface ExportJob {
  id: string;
  state: "queued" | "processing" | "completed" | "failed";
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  // PRIV-002 "category selection"/"size/progress" — null selectedCategories means "everything" (the only
  // value every export requested before this feature existed has); itemCount/estimatedSizeBytes stay null
  // until the worker finishes building the manifest (see DataExportService.buildManifest/worker-main.ts).
  selectedCategories: string[] | null;
  itemCount: number | null;
  estimatedSizeBytes: number | null;
}

// Kept in sync by hand with services/api/src/modules/data-export/dto.ts's EXPORT_CATEGORIES — a plain web
// page can't import a backend module, so this is the display-label counterpart of that same list.
const EXPORT_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "purchases", label: "Purchases" },
  { value: "bills", label: "Bills" },
  { value: "warranties", label: "Warranties" },
  { value: "subscriptions", label: "Subscriptions" },
  { value: "calendarEvents", label: "Calendar events" },
  { value: "tasks", label: "Tasks" },
  { value: "documents", label: "Documents (metadata only)" },
  { value: "inboxItems", label: "Inbox items" },
  { value: "notifications", label: "Notifications" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const { data, isLoading, error: listError, mutate } = useSWR<ExportJob[]>("/v1/data-export", swrFetcher, {
    refreshInterval: (latest) => (latest?.some((j) => j.state === "queued" || j.state === "processing") ? 3000 : 0),
  });
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // §28.9 step-up auth: the API only actually requires a password for accounts that have one (OAuth-only
  // accounts skip the check server-side) — so this tries with none first, and only shows the prompt if
  // the server comes back asking for it, rather than asking everyone up front.
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  // PRIV-002 "category selection" — empty set means "export everything," matching the pre-existing
  // behavior (sent as `undefined`, never `[]`, so the server's own "omitted = everything" default applies).
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

  function toggleCategory(value: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  async function requestExport(withPassword?: string) {
    setRequesting(true);
    setError(null);
    try {
      await api.post("/v1/data-export", {
        password: withPassword,
        selectedCategories: selectedCategories.size > 0 ? Array.from(selectedCategories) : undefined,
      });
      setPasswordPromptOpen(false);
      setPassword("");
      mutate();
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptOpen(true);
        return;
      }
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
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-tertiary">A new export reflects your data as of the moment you request it.</p>
            {!passwordPromptOpen && (
              <Button className="shrink-0 whitespace-nowrap" onClick={() => requestExport()} loading={requesting}>
                {selectedCategories.size > 0 ? `Export ${selectedCategories.size} selected` : "Export everything"}
              </Button>
            )}
          </div>
          <div className="border-t border-border-subtle pt-3">
            <p className="text-sm font-medium text-primary">Choose what to include</p>
            <p className="mt-0.5 text-sm text-tertiary">Leave everything unchecked to export all of your data (the default).</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {EXPORT_CATEGORY_OPTIONS.map((category) => (
                <label key={category.value} className="flex items-center gap-2 text-sm text-primary">
                  <input
                    type="checkbox"
                    checked={selectedCategories.has(category.value)}
                    onChange={() => toggleCategory(category.value)}
                    className="size-4 rounded border-border-subtle"
                  />
                  {category.label}
                </label>
              ))}
            </div>
          </div>
          {passwordPromptOpen && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                requestExport(password);
              }}
              className="space-y-3"
              noValidate
            >
              <div>
                <Label htmlFor="export-password">Confirm your password to continue</Label>
                <Input
                  id="export-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="flex gap-3">
                <Button type="submit" size="sm" loading={requesting}>
                  Confirm
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setPasswordPromptOpen(false);
                    setPassword("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardBody>
      </Card>

      {error && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {error}
        </p>
      )}

      {/* Bug fix: found live via a forced 500 on GET /v1/data-export — `isLoading` settles to false on
          error too, and `data` stays undefined (not `[]`), so this page had no branch for a real fetch
          failure: the list silently vanished with no error and no way to retry short of a reload. */}
      {!isLoading && listError && !data && (
        <FetchError what="your past exports" message={listError instanceof ApiError ? listError.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !listError && data?.length === 0 && (
        <EmptyState title="No exports yet" description="Request one above — it usually takes just a moment." />
      )}

      {data && data.length > 0 && (
        <ul className="space-y-3">
          {data.map((job) => (
            <li key={job.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
                      {/* PRIV-002 "size/progress" — real numbers once the worker finishes building the
                          manifest, not just the state badge alone. */}
                      {job.state === "completed" && job.itemCount !== null && (
                        <span className="text-sm text-tertiary">
                          {job.itemCount} item{job.itemCount === 1 ? "" : "s"}
                          {job.estimatedSizeBytes !== null && ` · ${formatBytes(job.estimatedSizeBytes)}`}
                        </span>
                      )}
                      {(job.state === "queued" || job.state === "processing") && (
                        <span className="text-sm text-tertiary">{job.state === "queued" ? "Waiting to start…" : "Building your export…"}</span>
                      )}
                    </div>
                    <p className="text-sm text-tertiary">
                      Requested {formatWhen(job.requestedAt)}
                      {job.completedAt ? ` · Ready ${formatWhen(job.completedAt)}` : ""}
                      {job.expiresAt ? ` · Available until ${formatWhen(job.expiresAt)}` : ""}
                    </p>
                    {job.selectedCategories && job.selectedCategories.length > 0 && (
                      <p className="text-sm text-tertiary">
                        Includes: {job.selectedCategories.map((c) => EXPORT_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c).join(", ")}
                      </p>
                    )}
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
