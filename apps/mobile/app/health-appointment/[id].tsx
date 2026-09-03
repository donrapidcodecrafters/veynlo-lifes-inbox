import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
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
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";

interface HealthAppointmentDetail {
  appointment: {
    id: string;
    providerName: string | null;
    appointmentType: string | null;
    dateTime: TemporalValueLike;
    location: string | null;
    prepInstructions: string | null;
    visibility: "private" | "household";
  };
  linkedBills: Array<{
    id: string;
    billerLabel: string;
    amountDueMinorUnits: number | null;
    amountDueCurrency: string | null;
    needsAmountReview: boolean;
  }>;
  linkedTasks: Array<{ id: string; title: string }>;
  linkedDocuments: Array<{ id: string; title: string; documentType: string }>;
  // AI-001 "why am I seeing this?" — null for a manually-entered appointment or one with no traceable
  // source event; populated for one discovered from an email (IngestionService.extractHealthAppointment).
  evidence: Evidence | null;
}

interface PickableBill {
  bill: { id: string; billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null; healthAppointmentId: string | null };
}

interface PickableTask {
  id: string;
  title: string;
  healthAppointmentId: string | null;
}

interface PickableDocument {
  id: string;
  title: string;
  documentType: string;
  linkedEntityIds: string[];
}

function Pill({ label, onPress, tone = "default" }: { label: string; onPress: () => void; tone?: "default" | "critical" }) {
  const { theme } = useAppTheme();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.colors.bgSubtle }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: tone === "critical" ? theme.colors.critical : theme.colors.textPrimary }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Mobile counterpart to apps/web/src/app/(app)/life/health-appointments/[id]/page.tsx — see that file's own
 * doc comment for the spec-retraceability gap (HLTH-001/002/004) this whole detail screen closes: linking
 * an existing task or insurance-card/EOB document to an appointment, finally reaching the already-real (but
 * previously UI-unreachable) bill-linking backend, and a step-up-gated export of this appointment's packet.
 */
export default function HealthAppointmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<HealthAppointmentDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<HealthAppointmentDetail | null>(`/v1/health/appointments/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this appointment"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This appointment doesn't exist or you don't have access to it." /></Screen>;

  const { appointment, linkedBills, linkedTasks, linkedDocuments, evidence } = data;
  const when = formatTemporal(appointment.dateTime);

  return (
    <Screen>
      <ScreenHeader title={appointment.providerName ?? appointment.appointmentType ?? "Appointment"} subtitle={when ?? undefined} />

      <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
        Private by default — logistics only. Never a symptom, diagnosis, or medication dose.
      </Text>

      <Card style={{ gap: 6 }}>
        <Badge tone={appointment.visibility === "private" ? "neutral" : "brand"}>{appointment.visibility === "private" ? "Private" : "Household"}</Badge>
        {appointment.appointmentType && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{appointment.appointmentType}</Text>}
        {appointment.location && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{appointment.location}</Text>}
        {appointment.prepInstructions && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Prep: {appointment.prepInstructions}</Text>}
      </Card>

      <BillsPanel appointmentId={appointment.id} linkedBills={linkedBills} onChanged={load} />
      <TasksPanel appointmentId={appointment.id} linkedTasks={linkedTasks} onChanged={load} />
      <DocumentsPanel appointmentId={appointment.id} linkedDocuments={linkedDocuments} onChanged={load} />
      <EvidenceCard evidence={evidence} />
      <ExportPanel appointmentId={appointment.id} />
    </Screen>
  );
}

function BillsPanel({ appointmentId, linkedBills, onChanged }: { appointmentId: string; linkedBills: HealthAppointmentDetail["linkedBills"]; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [allBills, setAllBills] = useState<PickableBill[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<PickableBill[]>("/v1/bills").then(setAllBills).catch(() => {});
  }, []);

  const pickable = allBills.filter((row) => row.bill.healthAppointmentId == null);

  async function link(billId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/bills/${billId}/link-appointment`, { healthAppointmentId: appointmentId });
      api.get<PickableBill[]>("/v1/bills").then(setAllBills).catch(() => {});
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that bill.");
    } finally {
      setBusy(false);
    }
  }

  async function dismissReview(billId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/bills/${billId}/clear-amount-review`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't dismiss that flag.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Bills</Text>
      {linkedBills.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No bills linked yet.</Text>}
      {linkedBills.map((b) => (
        <View key={b.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{b.billerLabel}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{formatMoneyMinorUnits(b.amountDueMinorUnits, b.amountDueCurrency) ?? "Amount unknown"}</Text>
            </View>
            {b.needsAmountReview && <Badge tone="warning">Review</Badge>}
          </View>
          {b.needsAmountReview && (
            <Button variant="secondary" onPress={() => dismissReview(b.id)} disabled={busy}>
              Looks correct
            </Button>
          )}
        </View>
      ))}
      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary, marginTop: 4 }}>Link a bill</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {pickable.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No unlinked bills.</Text>}
        {pickable.map((row) => (
          <Pill key={row.bill.id} label={`${row.bill.billerLabel}`} onPress={() => link(row.bill.id)} />
        ))}
      </View>
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

function TasksPanel({ appointmentId, linkedTasks, onChanged }: { appointmentId: string; linkedTasks: HealthAppointmentDetail["linkedTasks"]; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [allTasks, setAllTasks] = useState<PickableTask[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshTasks = useCallback(() => {
    api.get<PickableTask[]>("/v1/tasks").then(setAllTasks).catch(() => {});
  }, []);

  useEffect(refreshTasks, [refreshTasks]);

  const pickable = allTasks.filter((t) => t.healthAppointmentId == null);

  async function link(taskId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/tasks/${taskId}/link-appointment`, { healthAppointmentId: appointmentId });
      refreshTasks();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that task.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(taskId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/tasks/${taskId}/unlink-appointment`);
      refreshTasks();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't unlink that task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Tasks</Text>
      {linkedTasks.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No prep tasks linked yet — e.g. &quot;bring insurance card.&quot;</Text>}
      {linkedTasks.map((t) => (
        <View key={t.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{t.title}</Text>
          <Pressable accessibilityRole="button" onPress={() => unlink(t.id)} disabled={busy}>
            <Text style={{ fontSize: 13, color: theme.colors.critical }}>Unlink</Text>
          </Pressable>
        </View>
      ))}
      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary, marginTop: 4 }}>Link a task</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {pickable.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No unlinked tasks.</Text>}
        {pickable.map((t) => (
          <Pill key={t.id} label={t.title} onPress={() => link(t.id)} />
        ))}
      </View>
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

function DocumentsPanel({ appointmentId, linkedDocuments, onChanged }: { appointmentId: string; linkedDocuments: HealthAppointmentDetail["linkedDocuments"]; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [allDocuments, setAllDocuments] = useState<PickableDocument[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [passwordPromptFor, setPasswordPromptFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const refreshDocuments = useCallback(() => {
    api.get<PickableDocument[]>("/v1/documents").then(setAllDocuments).catch(() => {});
  }, []);

  useEffect(refreshDocuments, [refreshDocuments]);

  const pickable = allDocuments.filter((d) => (d.documentType === "insurance_card" || d.documentType === "eob") && !d.linkedEntityIds.includes(appointmentId));

  async function link(documentId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/documents/${documentId}/link-appointment`, { healthAppointmentId: appointmentId });
      refreshDocuments();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that document.");
    } finally {
      setBusy(false);
    }
  }

  async function unlink(documentId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/documents/${documentId}/unlink-appointment`, { healthAppointmentId: appointmentId });
      refreshDocuments();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't unlink that document.");
    } finally {
      setBusy(false);
    }
  }

  async function open(documentId: string, withPassword?: string) {
    setOpeningId(documentId);
    setError(null);
    try {
      const result = await api.post<{ url: string }>(`/v1/health/documents/${documentId}/unlock`, { password: withPassword });
      setPasswordPromptFor(null);
      setPassword("");
      await Clipboard.setStringAsync(result.url);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptFor(documentId);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't open that document.");
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Insurance card / EOB documents</Text>
      {linkedDocuments.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No documents linked yet.</Text>}
      {linkedDocuments.map((d) => (
        <View key={d.id} style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{d.title}</Text>
            <Pressable accessibilityRole="button" onPress={() => unlink(d.id)} disabled={busy}>
              <Text style={{ fontSize: 13, color: theme.colors.critical }}>Unlink</Text>
            </Pressable>
          </View>
          <Button variant="secondary" onPress={() => open(d.id)} loading={openingId === d.id}>
            Open (copies link to clipboard)
          </Button>
          {passwordPromptFor === d.id && (
            <View style={{ gap: 8 }}>
              <TextField label="Confirm your password to open this" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} autoFocus />
              <Button onPress={() => open(d.id, password)} loading={openingId === d.id}>
                Unlock
              </Button>
            </View>
          )}
        </View>
      ))}
      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary, marginTop: 4 }}>Attach an insurance card or EOB</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {pickable.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No unlinked insurance-card/EOB documents. Upload one from Documents.</Text>}
        {pickable.map((d) => (
          <Pill key={d.id} label={d.title} onPress={() => link(d.id)} />
        ))}
      </View>
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

/** HLTH-001 "export selected packet" — same synchronous, step-up-gated endpoint the web detail page uses
 * (POST /v1/health/export). Mobile has no filesystem-download equivalent to a browser `<a download>`, and
 * no expo-file-system/expo-sharing dependency already installed in this app (checked package.json) — rather
 * than adding a new native dependency for one button, this copies the JSON packet to the clipboard using
 * expo-clipboard (already a dependency — see connections.tsx's identical copy-to-clipboard pattern), so the
 * user can paste it into Notes/Files/email to save it. */
function ExportPanel({ appointmentId }: { appointmentId: string }) {
  const { theme } = useAppTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");

  async function exportPacket(withPassword?: string) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const manifest = await api.post(`/v1/health/export`, { appointmentId, password: withPassword });
      setPasswordPromptOpen(false);
      setPassword("");
      await Clipboard.setStringAsync(JSON.stringify(manifest, null, 2));
      setCopied(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptOpen(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't export this appointment's packet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Export this appointment&apos;s packet</Text>
      <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Copies a JSON packet (this appointment, its linked bills and prep tasks) to your clipboard.</Text>
      {!passwordPromptOpen && (
        <Button variant="secondary" onPress={() => exportPacket()} loading={busy}>
          Export
        </Button>
      )}
      {passwordPromptOpen && (
        <View style={{ gap: 8 }}>
          <TextField label="Confirm your password to continue" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} autoFocus />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={() => exportPacket(password)} loading={busy}>
                Confirm
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => { setPasswordPromptOpen(false); setPassword(""); }}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
      {copied && <Text style={{ fontSize: 13, color: theme.colors.positive }}>Copied to clipboard.</Text>}
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}
