"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
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
    householdId: string | null;
    status: string;
  };
  linkedBills: Array<{
    id: string;
    billerLabel: string;
    amountDueMinorUnits: number | null;
    amountDueCurrency: string | null;
    dueDate: TemporalValueLike;
    needsAmountReview: boolean;
  }>;
  linkedTasks: Array<{ id: string; title: string; dueCondition: TemporalValueLike | null; state: string }>;
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

/**
 * HLTH-001/002/004 "forms/tasks", "attach form/card/bill", and "export selected packet" — found live via a
 * spec-retraceability audit: the backend already had real logic for linking a bill to an appointment
 * (HealthLogisticsService.linkBillToAppointment), but zero UI anywhere called it, no UI let a task be linked
 * at all (the backend had no linking mechanism either — see tasks.healthAppointmentId, added alongside this
 * page), and no export existed for this domain. This is the standalone appointment detail page item 4 of
 * that audit calls for — the natural home for all three, rather than cramming pickers into the Life page's
 * inline appointment card (see life/page.tsx's Health section, which now just links here).
 */
export default function HealthAppointmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<HealthAppointmentDetail | null>(`/v1/health/appointments/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this appointment" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This appointment doesn't exist or you don't have access to it." />;

  const { appointment, linkedBills, linkedTasks, linkedDocuments, evidence } = data;
  const when = formatTemporal(appointment.dateTime);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{appointment.providerName ?? appointment.appointmentType ?? "Appointment"}</h1>
          {when && <p className="mt-1 text-sm text-tertiary">{when}</p>}
        </div>
        <Badge tone={appointment.visibility === "private" ? "neutral" : "info"}>{appointment.visibility === "private" ? "Private" : "Household"}</Badge>
      </header>

      <p className="text-xs text-tertiary">
        Private by default — logistics only (provider, when, where, prep instructions). Never a symptom, diagnosis, or medication dose.
      </p>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {appointment.appointmentType && (
              <>
                <dt className="text-tertiary">Type</dt>
                <dd className="capitalize text-primary">{appointment.appointmentType}</dd>
              </>
            )}
            {appointment.location && (
              <>
                <dt className="text-tertiary">Location</dt>
                <dd className="break-words text-primary">{appointment.location}</dd>
              </>
            )}
            {appointment.prepInstructions && (
              <>
                <dt className="text-tertiary">Prep</dt>
                <dd className="break-words text-primary">{appointment.prepInstructions}</dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <BillsPanel appointmentId={appointment.id} linkedBills={linkedBills} onChanged={() => mutate()} />
      <TasksPanel appointmentId={appointment.id} linkedTasks={linkedTasks} onChanged={() => mutate()} />
      <DocumentsPanel appointmentId={appointment.id} linkedDocuments={linkedDocuments} onChanged={() => mutate()} />
      <EvidenceCard evidence={evidence} />
      <ExportPanel appointmentId={appointment.id} />
    </div>
  );
}

/** HLTH-004 — surfaces the linked bills the backend already tracked with no UI, plus a picker that finally
 * calls the existing (and, per a prior audit, tested-but-unreachable) POST .../bills/:billId/link-appointment. */
function BillsPanel({
  appointmentId,
  linkedBills,
  onChanged,
}: {
  appointmentId: string;
  linkedBills: HealthAppointmentDetail["linkedBills"];
  onChanged: () => void;
}) {
  const { data: allBills, mutate: mutateBills } = useSWR<PickableBill[]>("/v1/bills", swrFetcher);
  const [selectedBillId, setSelectedBillId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickableBills = (allBills ?? []).filter((row) => row.bill.healthAppointmentId == null);

  async function link() {
    if (!selectedBillId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/bills/${selectedBillId}/link-appointment`, { healthAppointmentId: appointmentId });
      setSelectedBillId("");
      mutateBills();
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
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm font-medium text-primary">Bills</p>
        {linkedBills.length === 0 && <p className="text-sm text-tertiary">No bills linked yet.</p>}
        {linkedBills.length > 0 && (
          <ul className="space-y-2">
            {linkedBills.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2">
                <div className="min-w-0">
                  <p className="break-words text-sm text-primary">{b.billerLabel}</p>
                  <p className="text-xs text-tertiary">{formatMoneyMinorUnits(b.amountDueMinorUnits, b.amountDueCurrency) ?? "Amount unknown"}</p>
                </div>
                {b.needsAmountReview && (
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone="warning">Review amount</Badge>
                    <Button size="sm" variant="secondary" onClick={() => dismissReview(b.id)} disabled={busy}>
                      Looks correct
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-xs text-tertiary">Link a bill</label>
            <select
              value={selectedBillId}
              onChange={(e) => setSelectedBillId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="">Choose an unlinked bill…</option>
              {pickableBills.map((row) => (
                <option key={row.bill.id} value={row.bill.id}>
                  {row.bill.billerLabel} — {formatMoneyMinorUnits(row.bill.amountDueMinorUnits, row.bill.amountDueCurrency) ?? "amount unknown"}
                </option>
              ))}
            </select>
            {pickableBills.length === 0 && <p className="mt-1 text-xs text-tertiary">No unlinked bills to attach.</p>}
          </div>
          <Button onClick={link} disabled={busy || !selectedBillId} size="sm">
            Link
          </Button>
        </div>
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** HLTH-001 "forms/tasks" linkage — the gap the audit found: no way anywhere to attach a prep task
 * ("bring insurance card," "fast for 8 hours before") to a health appointment. */
function TasksPanel({
  appointmentId,
  linkedTasks,
  onChanged,
}: {
  appointmentId: string;
  linkedTasks: HealthAppointmentDetail["linkedTasks"];
  onChanged: () => void;
}) {
  const { data: allTasks, mutate: mutateTasks } = useSWR<PickableTask[]>("/v1/tasks", swrFetcher);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickableTasks = (allTasks ?? []).filter((t) => t.healthAppointmentId == null);

  async function link() {
    if (!selectedTaskId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/tasks/${selectedTaskId}/link-appointment`, { healthAppointmentId: appointmentId });
      setSelectedTaskId("");
      mutateTasks();
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
      mutateTasks();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't unlink that task.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm font-medium text-primary">Tasks</p>
        {linkedTasks.length === 0 && <p className="text-sm text-tertiary">No prep tasks linked yet — e.g. &quot;bring insurance card.&quot;</p>}
        {linkedTasks.length > 0 && (
          <ul className="space-y-2">
            {linkedTasks.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2">
                <p className="min-w-0 break-words text-sm text-primary">{t.title}</p>
                <Button size="sm" variant="ghost" onClick={() => unlink(t.id)} disabled={busy}>
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-xs text-tertiary">Link a task</label>
            <select
              value={selectedTaskId}
              onChange={(e) => setSelectedTaskId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="">Choose an unlinked task…</option>
              {pickableTasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            {pickableTasks.length === 0 && <p className="mt-1 text-xs text-tertiary">No unlinked tasks to attach.</p>}
          </div>
          <Button onClick={link} disabled={busy || !selectedTaskId} size="sm">
            Link
          </Button>
        </div>
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** HLTH-001/002 "attach form/card/bill" — scoped to just insurance_card/eob documents (HEALTH_DOCUMENT_TYPES),
 * linked via documents.linkedEntityIds. Opening one still costs the existing §28.9 step-up password, same as
 * everywhere else this domain surfaces a health document (mirrors emergency-binder/settings/data-export's
 * "try with no password, prompt only if the server asks" pattern). */
function DocumentsPanel({
  appointmentId,
  linkedDocuments,
  onChanged,
}: {
  appointmentId: string;
  linkedDocuments: HealthAppointmentDetail["linkedDocuments"];
  onChanged: () => void;
}) {
  const { data: allDocuments, mutate: mutateDocuments } = useSWR<PickableDocument[]>("/v1/documents", swrFetcher);
  const [selectedDocumentId, setSelectedDocumentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [passwordPromptFor, setPasswordPromptFor] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const pickableDocuments = (allDocuments ?? []).filter(
    (d) => (d.documentType === "insurance_card" || d.documentType === "eob") && !d.linkedEntityIds.includes(appointmentId),
  );

  async function link() {
    if (!selectedDocumentId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/health/documents/${selectedDocumentId}/link-appointment`, { healthAppointmentId: appointmentId });
      setSelectedDocumentId("");
      mutateDocuments();
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
      mutateDocuments();
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
      window.open(result.url, "_blank", "noopener,noreferrer");
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
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm font-medium text-primary">Insurance card / EOB documents</p>
        {linkedDocuments.length === 0 && <p className="text-sm text-tertiary">No documents linked yet.</p>}
        {linkedDocuments.length > 0 && (
          <ul className="space-y-2">
            {linkedDocuments.map((d) => (
              <li key={d.id} className="rounded-lg border border-border-subtle px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 break-words text-sm text-primary">{d.title}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" variant="secondary" onClick={() => open(d.id)} loading={openingId === d.id}>
                      Open
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => unlink(d.id)} disabled={busy}>
                      Unlink
                    </Button>
                  </div>
                </div>
                {passwordPromptFor === d.id && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      open(d.id, password);
                    }}
                    className="mt-2 flex flex-wrap items-end gap-2"
                    noValidate
                  >
                    <div>
                      <Label htmlFor={`doc-password-${d.id}`}>Confirm your password to open this</Label>
                      <Input id={`doc-password-${d.id}`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
                    </div>
                    <Button type="submit" size="sm" loading={openingId === d.id}>
                      Unlock
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label className="mb-1 block text-xs text-tertiary">Attach an insurance card or EOB</label>
            <select
              value={selectedDocumentId}
              onChange={(e) => setSelectedDocumentId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="">Choose a document…</option>
              {pickableDocuments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} ({d.documentType === "insurance_card" ? "Insurance card" : "EOB"})
                </option>
              ))}
            </select>
            {pickableDocuments.length === 0 && (
              <p className="mt-1 text-xs text-tertiary">
                No unlinked insurance-card/EOB documents. Upload one from{" "}
                <Link href="/documents" className="text-brand hover:underline">
                  Documents
                </Link>
                .
              </p>
            )}
          </div>
          <Button onClick={link} disabled={busy || !selectedDocumentId} size="sm">
            Attach
          </Button>
        </div>
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** HLTH-001 "export selected packet" — reuses DataExportService's JSON-manifest infrastructure, scoped to
 * just this one appointment, gated behind the same §28.9 step-up password the rest of Health Logistics
 * requires (see HealthLogisticsService.exportHealthPacket). Returned synchronously (small payload), so this
 * downloads it directly rather than polling a job like settings/data-export's full-account export does. */
function ExportPanel({ appointmentId }: { appointmentId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");

  async function exportPacket(withPassword?: string) {
    setBusy(true);
    setError(null);
    try {
      const manifest = await api.post(`/v1/health/export`, { appointmentId, password: withPassword });
      setPasswordPromptOpen(false);
      setPassword("");
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `veynlo-health-appointment-${appointmentId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
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
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-primary">Export this appointment&apos;s packet</p>
            <p className="text-xs text-tertiary">A JSON file with this appointment, its linked bills, and linked prep tasks.</p>
          </div>
          {!passwordPromptOpen && (
            <Button variant="secondary" size="sm" onClick={() => exportPacket()} loading={busy}>
              Export
            </Button>
          )}
        </div>
        {passwordPromptOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              exportPacket(password);
            }}
            className="space-y-3"
            noValidate
          >
            <div>
              <Label htmlFor="export-appt-password">Confirm your password to continue</Label>
              <Input id="export-appt-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            <div className="flex gap-3">
              <Button type="submit" size="sm" loading={busy}>
                Confirm
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => { setPasswordPromptOpen(false); setPassword(""); }}>
                Cancel
              </Button>
            </div>
          </form>
        )}
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}
