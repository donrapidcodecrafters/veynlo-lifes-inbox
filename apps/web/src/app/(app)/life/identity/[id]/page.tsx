"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";

type IdentityRecordType = "passport" | "drivers_license" | "vehicle_registration" | "professional_license" | "property_obligation";

const RECORD_TYPE_LABELS: Record<IdentityRecordType, string> = {
  passport: "Passport",
  drivers_license: "Driver's license",
  vehicle_registration: "Vehicle registration",
  professional_license: "Professional/recreational license",
  property_obligation: "Property/government obligation",
};

interface IdentityRecordDetail {
  record: {
    id: string;
    recordType: IdentityRecordType;
    label: string;
    issuingAuthority: string | null;
    issuedDate: TemporalValueLike | null;
    expirationDate: TemporalValueLike | null;
    jurisdiction: string | null;
    renewalUrl: string | null;
    reminderLeadDays: number;
    status: "active" | "expired" | "renewed";
    linkedVehicleId: string | null;
    linkedPropertyId: string | null;
    linkedDocumentId: string | null;
  };
  renewalLink: { url: string; label: string; sourceNote: string | null; source: "user" | "seeded" } | null;
  linkedDocument: { id: string; title: string; documentType: string } | null;
  linkedVehicle: { id: string; label: string } | null;
  linkedProperty: { id: string; label: string } | null;
  previousVersion: { id: string; label: string } | null;
}

/** "Reveal/copy protected field" — §28.9 step-up, mirroring the identical `open(documentId, withPassword)`
 * pattern life/health-appointments/[id]/page.tsx's DocumentsPanel already uses for exactly this shape of
 * gate (try with no password first — a no-op for an OAuth-only account — prompt only if the server asks). */
function RevealDocumentNumberPanel({ recordId }: { recordId: string }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  async function reveal(withPassword?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ documentNumber: string | null }>(`/v1/identity-records/${recordId}/reveal-document-number`, { password: withPassword });
      setRevealed(result.documentNumber);
      setPasswordPromptOpen(false);
      setPassword("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptOpen(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't reveal that field.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — the value is still shown on screen to copy manually.
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm font-medium text-primary">Document / ID number</p>
        {revealed === null && !passwordPromptOpen && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-tertiary">•••• •••• •••• — hidden until you confirm your password</p>
            <Button size="sm" variant="secondary" onClick={() => reveal()} loading={busy}>
              Reveal
            </Button>
          </div>
        )}
        {passwordPromptOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reveal(password);
            }}
            className="flex flex-wrap items-end gap-2"
            noValidate
          >
            <div>
              <Label htmlFor="reveal-password">Confirm your password to reveal this</Label>
              <Input id="reveal-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            </div>
            <Button type="submit" size="sm" loading={busy}>
              Unlock
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => { setPasswordPromptOpen(false); setPassword(""); }}>
              Cancel
            </Button>
          </form>
        )}
        {revealed !== null && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-subtle px-3 py-2">
            <p className="break-all font-mono text-sm text-primary">{revealed || "(none on file)"}</p>
            <div className="flex shrink-0 items-center gap-2">
              {revealed && (
                <Button size="sm" variant="secondary" onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
                Hide
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}

function RenewPanel({ record, onRenewed }: { record: IdentityRecordDetail["record"]; onRenewed: (newId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [expirationIso, setExpirationIso] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (record.status === "renewed") return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ id: string }>(`/v1/identity-records/${record.id}/renew`, {
        expirationIso: expirationIso || undefined,
        documentNumber: documentNumber || undefined,
      });
      onRenewed(result.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't renew this record.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-primary">Mark renewed</p>
            <p className="text-xs text-tertiary">Creates a new record for the renewed document and marks this one as replaced — nothing is deleted.</p>
          </div>
          {!open && (
            <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
              Renew
            </Button>
          )}
        </div>
        {open && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <div className="min-w-[160px] flex-1">
                <Label htmlFor="renew-expiration">New expiration date</Label>
                <Input id="renew-expiration" type="date" value={expirationIso} onChange={(e) => setExpirationIso(e.target.value)} />
              </div>
              <div className="min-w-[160px] flex-1">
                <Label htmlFor="renew-doc-number">New document/ID number (optional)</Label>
                <Input id="renew-doc-number" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} maxLength={200} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submit} loading={busy}>
                Confirm renewal
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
            {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function JurisdictionLinkPanel({ record, renewalLink, onSaved }: { record: IdentityRecordDetail["record"]; renewalLink: IdentityRecordDetail["renewalLink"]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState(renewalLink?.url ?? "");
  const [label, setLabel] = useState(renewalLink?.label ?? "Official renewal site");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!record.jurisdiction) {
      setError("Set a jurisdiction on this record first (edit above).");
      return;
    }
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.put("/v1/identity-records/jurisdiction-links", { recordType: record.recordType, jurisdiction: record.jurisdiction, url, label });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm font-medium text-primary">Official renewal link</p>
        {!editing && (
          <>
            {renewalLink ? (
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <a href={renewalLink.url} target="_blank" rel="noopener noreferrer" className="break-words text-sm text-brand hover:underline">
                    {renewalLink.label}
                  </a>
                  <p className="text-xs text-tertiary">{renewalLink.source === "user" ? "Your saved link" : "Curated official source — verify before relying on it"}</p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Correct
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-tertiary">No official link on file for this jurisdiction yet.</p>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Add a link
                </Button>
              </div>
            )}
          </>
        )}
        {editing && (
          <div className="space-y-2">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Link label" maxLength={200} />
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
            <div className="flex gap-2">
              <Button size="sm" onClick={save} loading={busy} disabled={!url.trim()}>
                Save
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}

function ReminderLeadTimePanel({ record, onSaved }: { record: IdentityRecordDetail["record"]; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(String(record.reminderLeadDays));
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    setBusy(true);
    try {
      await api.put(`/v1/identity-records/${record.id}`, { reminderLeadDays: parsed });
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-primary">Reminder lead time</p>
          {!editing && <p className="text-xs text-tertiary">You&apos;ll be reminded {record.reminderLeadDays} days before this expires.</p>}
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <div className="w-24">
              <Input type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
            <Button size="sm" onClick={save} loading={busy}>
              Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

export default function IdentityRecordDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error, isLoading, mutate } = useSWR<IdentityRecordDetail | null>(`/v1/identity-records/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life/identity" className="text-sm text-tertiary hover:text-primary">
          ← Back to identity &amp; legal documents
        </Link>
        <FetchError what="this record" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This record doesn't exist or you don't have access to it." />;

  const { record, renewalLink, linkedDocument, linkedVehicle, linkedProperty, previousVersion } = data;
  const issued = record.issuedDate ? formatTemporal(record.issuedDate) : null;
  const expires = record.expirationDate ? formatTemporal(record.expirationDate) : null;

  return (
    <div className="space-y-6">
      <Link href="/life/identity" className="text-sm text-tertiary hover:text-primary">
        ← Back to identity &amp; legal documents
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{record.label}</h1>
          <p className="mt-1 text-sm text-tertiary">{RECORD_TYPE_LABELS[record.recordType]}</p>
        </div>
        <Badge tone={record.status === "expired" ? "critical" : record.status === "renewed" ? "neutral" : "positive"}>
          {record.status === "expired" ? "Expired" : record.status === "renewed" ? "Renewed" : "Active"}
        </Badge>
      </header>

      <p className="text-xs text-tertiary">Private by default — never visible to a household member just because you&apos;re in the same household. Share it explicitly below if you need to.</p>

      {record.status === "renewed" && (
        <div className="rounded-xl border border-border-subtle bg-subtle px-4 py-3 text-sm text-secondary">This record has been renewed — see the newer version from your records list.</div>
      )}
      {previousVersion && (
        <div className="rounded-xl border border-border-subtle bg-subtle px-4 py-3 text-sm text-secondary">
          Renewed from{" "}
          <Link href={`/life/identity/${previousVersion.id}`} className="text-brand hover:underline">
            {previousVersion.label}
          </Link>
          .
        </div>
      )}

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {record.issuingAuthority && (
              <>
                <dt className="text-tertiary">Issuing authority</dt>
                <dd className="break-words text-primary">{record.issuingAuthority}</dd>
              </>
            )}
            {issued && (
              <>
                <dt className="text-tertiary">Issued</dt>
                <dd className="text-primary">{issued}</dd>
              </>
            )}
            {expires && (
              <>
                <dt className="text-tertiary">Expires</dt>
                <dd className="text-primary">{expires}</dd>
              </>
            )}
            {record.jurisdiction && (
              <>
                <dt className="text-tertiary">Jurisdiction</dt>
                <dd className="text-primary">{record.jurisdiction}</dd>
              </>
            )}
            {linkedVehicle && (
              <>
                <dt className="text-tertiary">Vehicle</dt>
                <dd className="text-primary">{linkedVehicle.label}</dd>
              </>
            )}
            {linkedProperty && (
              <>
                <dt className="text-tertiary">Property</dt>
                <dd className="text-primary">{linkedProperty.label}</dd>
              </>
            )}
            {linkedDocument && (
              <>
                <dt className="text-tertiary">Scanned document</dt>
                <dd className="text-primary">
                  <Link href="/documents" className="text-brand hover:underline">
                    {linkedDocument.title}
                  </Link>
                </dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <RevealDocumentNumberPanel recordId={record.id} />
      <ReminderLeadTimePanel record={record} onSaved={() => mutate()} />
      <JurisdictionLinkPanel record={record} renewalLink={renewalLink} onSaved={() => mutate()} />
      <RenewPanel record={record} onRenewed={(newId) => router.push(`/life/identity/${newId}`)} />

      <Card>
        <CardBody>
          <p className="mb-2 text-sm font-medium text-primary">Share</p>
          <p className="mb-3 text-xs text-tertiary">No public links — share directly with someone&apos;s Veynlo account (e.g. for an emergency or travel packet).</p>
          <ShareResourcePanel resourceId={record.id} collectionPath="/v1/identity-records" resourceLabel="record" />
        </CardBody>
      </Card>
    </div>
  );
}
