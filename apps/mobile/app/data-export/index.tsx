import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Switch, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";

interface ExportJob {
  id: string;
  state: "queued" | "processing" | "completed" | "failed";
  requestedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  errorMessage: string | null;
  // PRIV-002 "category selection"/"size/progress" — null selectedCategories means "everything" (the only
  // value every export requested before this feature existed has); itemCount/estimatedSizeBytes stay null
  // until the worker finishes building the manifest. Mirrors apps/web's identical fields
  // (settings/data-export/page.tsx).
  selectedCategories: string[] | null;
  itemCount: number | null;
  estimatedSizeBytes: number | null;
}

// Kept in sync by hand with services/api's EXPORT_CATEGORIES — same display-label list as apps/web's
// settings/data-export/page.tsx, just rendered as Switch rows here instead of web `<input type="checkbox">`s
// (this app has no separate checkbox component — every other boolean control here, e.g. settings.tsx's
// notification prefs, already uses the same Switch).
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

export default function DataExportScreen() {
  const { theme } = useAppTheme();
  const [jobs, setJobs] = useState<ExportJob[] | undefined>(undefined);
  const [requesting, setRequesting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // §28.9 step-up auth: try with no password first (OAuth-only accounts skip the check server-side
  // entirely), only prompt if the server actually asks for one.
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  // PRIV-002 "category selection" — empty set means "export everything," matching the pre-existing
  // behavior (sent as `undefined`, never `[]`, so the server's own "omitted = everything" default applies).
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function toggleCategory(value: string) {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const load = useCallback(async () => {
    // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx): an unguarded fetch called
    // fire-and-forget from a `useEffect` (both the mount effect and the poll `setInterval` below call this
    // without awaiting or catching) becomes an unhandled promise rejection on any transient network
    // failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the
    // entire app — worse here than most screens, since the poll would otherwise hit that failure every 3s.
    try {
      const data = await api.get<ExportJob[]>("/v1/data-export");
      setJobs(data);
      setError(null);
      return data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your exports. Please try again.");
      return undefined;
    }
  }, []);

  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  useEffect(() => {
    const hasPending = jobs?.some((j) => j.state === "queued" || j.state === "processing");
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(load, 3000);
    } else if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, [jobs, load]);

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
      await load();
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
      await Linking.openURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get a download link. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  }

  // Confirmed live: nothing previously stopped a second (or third, or fourth) export from being requested
  // while one was already queued/processing — the "Request export" button stayed active regardless of job
  // state, and the server has no single-flight guard of its own (POST /v1/data-export happily enqueues as
  // many jobs as the rate limit allows). Hiding the button while a job is pending is the client-side half
  // of the fix that's actually in scope here; each `job` card below still shows its own state either way.
  const hasPendingExport = jobs?.some((j) => j.state === "queued" || j.state === "processing") ?? false;

  return (
    <Screen>
      <ScreenHeader
        title="Export your data"
        subtitle="Download a copy of everything Veynlo has recorded for you."
      />

      <Card style={{ gap: 12 }}>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          A new export reflects your data as of the moment you request it.
        </Text>

        {!passwordPromptOpen && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 12 }}>
            <View>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Choose what to include</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
                Leave everything off to export all of your data (the default).
              </Text>
            </View>
            {EXPORT_CATEGORY_OPTIONS.map((category) => (
              <View key={category.value} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{category.label}</Text>
                <Switch
                  value={selectedCategories.has(category.value)}
                  onValueChange={() => toggleCategory(category.value)}
                  disabled={hasPendingExport}
                  accessibilityLabel={category.label}
                  trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                  {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
                />
              </View>
            ))}
          </View>
        )}

        {!passwordPromptOpen && hasPendingExport && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            An export is already in progress below — hang tight, it usually takes just a moment.
          </Text>
        )}
        {!passwordPromptOpen && !hasPendingExport && (
          <Button onPress={() => requestExport()} loading={requesting}>
            {selectedCategories.size > 0 ? `Export ${selectedCategories.size} selected` : "Export everything"}
          </Button>
        )}
        {passwordPromptOpen && (
          <View style={{ gap: 12 }}>
            <TextField
              label="Confirm your password to continue"
              secureTextEntry
              autoComplete="current-password"
              value={password}
              onChangeText={setPassword}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={() => requestExport(password)} loading={requesting}>
                  Confirm
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setPasswordPromptOpen(false);
                    setPassword("");
                  }}
                >
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}

      {/* Found live: `jobs` stayed null with nothing rendered here until the first `/v1/data-export`
          response landed — no skeleton, no spinner, just a blank gap indistinguishable from "no exports
          yet" (which itself couldn't show prematurely, since it's correctly gated on `jobs?.length === 0`
          rather than the loading state — but nothing filled the gap in the meantime either). */}
      {!jobs && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}

      {jobs?.length === 0 && <EmptyState title="No exports yet" description="Request one above — it usually takes just a moment." />}

      {jobs && jobs.length > 0 && (
        <View style={{ gap: 12 }}>
          {jobs.map((job) => (
            <Card key={job.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
                  {/* PRIV-002 "size/progress" — real numbers once the worker finishes building the
                      manifest, not just the state badge alone. */}
                  {job.state === "completed" && job.itemCount !== null && (
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                      {job.itemCount} item{job.itemCount === 1 ? "" : "s"}
                      {job.estimatedSizeBytes !== null ? ` · ${formatBytes(job.estimatedSizeBytes)}` : ""}
                    </Text>
                  )}
                  {(job.state === "queued" || job.state === "processing") && (
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                      {job.state === "queued" ? "Waiting to start…" : "Building your export…"}
                    </Text>
                  )}
                </View>
                {job.state === "completed" && (
                  <View style={{ minWidth: 110 }}>
                    <Button variant="secondary" onPress={() => download(job.id)} loading={downloadingId === job.id}>
                      Download
                    </Button>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Requested {formatWhen(job.requestedAt)}
                {job.completedAt ? ` · Ready ${formatWhen(job.completedAt)}` : ""}
                {job.expiresAt ? ` · Available until ${formatWhen(job.expiresAt)}` : ""}
              </Text>
              {job.selectedCategories && job.selectedCategories.length > 0 && (
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                  Includes: {job.selectedCategories.map((c) => EXPORT_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c).join(", ")}
                </Text>
              )}
              {job.state === "failed" && job.errorMessage && (
                <Text style={{ fontSize: 12, color: theme.colors.critical }}>{job.errorMessage}</Text>
              )}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
