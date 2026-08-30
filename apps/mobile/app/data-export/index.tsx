import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
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

export default function DataExportScreen() {
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [jobs, setJobs] = useState<ExportJob[] | undefined>(undefined);
  const [showConfirm, setShowConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const data = await api.get<ExportJob[]>("/v1/data-export");
    setJobs(data);
    return data;
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

  async function requestExport() {
    setRequesting(true);
    setError(null);
    try {
      await api.post("/v1/data-export", user?.hasPassword ? { password } : {});
      setShowConfirm(false);
      setPassword("");
      await load();
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
      await Linking.openURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get a download link. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <Screen>
      <ScreenHeader
        title="Export your data"
        subtitle="Download a copy of everything Veynlo has recorded for you."
      />

      <Card style={{ gap: 12 }}>
        {!showConfirm ? (
          <>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
              A new export reflects your data as of the moment you request it.
            </Text>
            <Button onPress={() => setShowConfirm(true)}>Request export</Button>
          </>
        ) : (
          <>
            {user?.hasPassword ? (
              <TextField
                label="Confirm your password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="password"
              />
            ) : (
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                Your account uses Google/Microsoft sign-in with no separate password — confirming here is enough.
              </Text>
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={requestExport} loading={requesting}>
                  Confirm export
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setShowConfirm(false);
                    setPassword("");
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </View>
            </View>
          </>
        )}
      </Card>

      {error && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{error}</Text>}

      {jobs?.length === 0 && <EmptyState title="No exports yet" description="Request one above — it usually takes just a moment." />}

      {jobs && jobs.length > 0 && (
        <View style={{ gap: 12 }}>
          {jobs.map((job) => (
            <Card key={job.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <Badge tone={STATE_TONE[job.state]}>{job.state}</Badge>
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
