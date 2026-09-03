"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

type IdentityRecordType = "passport" | "drivers_license" | "vehicle_registration" | "professional_license" | "property_obligation";

interface IdentityRecordRow {
  id: string;
  recordType: IdentityRecordType;
  label: string;
  expirationDate: TemporalValueLike | null;
  status: "active" | "expired" | "renewed";
}

interface VehicleOption {
  id: string;
  label: string;
}
interface PropertyOption {
  id: string;
  label: string;
}

const RECORD_TYPE_OPTIONS: Array<{ value: IdentityRecordType; label: string }> = [
  { value: "passport", label: "Passport" },
  { value: "drivers_license", label: "Driver's license / state ID" },
  { value: "vehicle_registration", label: "Vehicle registration" },
  { value: "professional_license", label: "Professional/recreational license" },
  { value: "property_obligation", label: "Property/government obligation" },
];

/**
 * "Identity & Legal Continuity" (ID-001..005) manual-add form — recordType/label/issuing authority/document
 * number/issued+expiration dates/jurisdiction/reminder lead time/optional vehicle-or-property link, all in
 * one place (unlike Health/Pets' lighter forms, this domain genuinely needs this many fields at creation
 * time — see spec's own "Scan/add" user action for each ID-* item). `documentNumber` is submitted here
 * exactly once, at creation, then never round-trips back to the client except through the dedicated,
 * step-up-gated reveal action on the detail page.
 */
function AddIdentityRecordForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [recordType, setRecordType] = useState<IdentityRecordType>("passport");
  const [label, setLabel] = useState("");
  const [issuingAuthority, setIssuingAuthority] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [issuedDate, setIssuedDate] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [reminderLeadDays, setReminderLeadDays] = useState("60");
  const [linkedVehicleId, setLinkedVehicleId] = useState("");
  const [linkedPropertyId, setLinkedPropertyId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: vehicles } = useSWR<VehicleOption[]>(open && recordType === "vehicle_registration" ? "/v1/vehicles" : null, swrFetcher);
  const { data: properties } = useSWR<PropertyOption[]>(open && recordType === "property_obligation" ? "/v1/properties" : null, swrFetcher);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add an identity record
      </button>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const days = reminderLeadDays.trim() ? Number(reminderLeadDays) : undefined;
      await api.post("/v1/identity-records", {
        recordType,
        label,
        issuingAuthority: issuingAuthority || undefined,
        documentNumber: documentNumber || undefined,
        issuedIso: issuedDate || undefined,
        expirationIso: expirationDate || undefined,
        jurisdiction: jurisdiction || undefined,
        reminderLeadDays: days,
        linkedVehicleId: linkedVehicleId || undefined,
        linkedPropertyId: linkedPropertyId || undefined,
      });
      setLabel("");
      setIssuingAuthority("");
      setDocumentNumber("");
      setIssuedDate("");
      setExpirationDate("");
      setJurisdiction("");
      setReminderLeadDays("60");
      setLinkedVehicleId("");
      setLinkedPropertyId("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that record.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <Label htmlFor="record-type">Type</Label>
          <select
            id="record-type"
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as IdentityRecordType)}
            className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
          >
            {RECORD_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (e.g. US Passport)" className="min-w-[180px] flex-1" maxLength={200} />
          <Input value={issuingAuthority} onChange={(e) => setIssuingAuthority(e.target.value)} placeholder="Issuing authority (optional)" className="min-w-[180px] flex-1" maxLength={200} />
        </div>
        <div>
          <Label htmlFor="doc-number">Document/ID number (optional — encrypted, never shown again without confirming your password)</Label>
          <Input id="doc-number" value={documentNumber} onChange={(e) => setDocumentNumber(e.target.value)} maxLength={200} />
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[160px] flex-1">
            <Label htmlFor="issued-date">Issued</Label>
            <Input id="issued-date" type="date" value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} />
          </div>
          <div className="min-w-[160px] flex-1">
            <Label htmlFor="expiration-date">Expires</Label>
            <Input id="expiration-date" type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-[140px] flex-1">
            <Label htmlFor="jurisdiction">Jurisdiction (e.g. US, US-CA)</Label>
            <Input id="jurisdiction" value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value.toUpperCase())} maxLength={20} />
          </div>
          <div className="w-40">
            <Label htmlFor="lead-days">Reminder lead time (days)</Label>
            <Input id="lead-days" type="number" min={1} value={reminderLeadDays} onChange={(e) => setReminderLeadDays(e.target.value)} />
          </div>
        </div>
        {recordType === "vehicle_registration" && vehicles && vehicles.length > 0 && (
          <div>
            <Label htmlFor="linked-vehicle">Vehicle</Label>
            <select id="linked-vehicle" value={linkedVehicleId} onChange={(e) => setLinkedVehicleId(e.target.value)} className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary">
              <option value="">Choose a vehicle…</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {recordType === "property_obligation" && properties && properties.length > 0 && (
          <div>
            <Label htmlFor="linked-property">Property</Label>
            <select id="linked-property" value={linkedPropertyId} onChange={(e) => setLinkedPropertyId(e.target.value)} className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary">
              <option value="">Choose a property…</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex gap-2">
          <Button onClick={submit} loading={submitting} disabled={!label.trim()}>
            Add
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

const RECORD_TYPE_LABELS: Record<IdentityRecordType, string> = {
  passport: "Passport",
  drivers_license: "Driver's license",
  vehicle_registration: "Vehicle registration",
  professional_license: "Professional/recreational license",
  property_obligation: "Property/government obligation",
};

export default function IdentityRecordsListPage() {
  const { data: records, error, isLoading, mutate } = useSWR<IdentityRecordRow[]>("/v1/identity-records", swrFetcher);
  const active = records?.filter((r) => r.status !== "renewed");

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Identity &amp; legal documents</h1>
        <p className="mt-1 text-sm text-tertiary">
          Passports, driver&apos;s licenses, vehicle registrations, professional licenses, and property/government obligations — private by default, each with its own
          expiration reminder. A document number is encrypted and only ever shown again after confirming your password.
        </p>
      </header>

      {error && !records ? (
        <FetchError what="your identity records" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      ) : (
        <>
          {isLoading && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
          {!isLoading && (!active || active.length === 0) && (
            <EmptyState title="No identity records yet" description="Add your first passport, license, registration, or permit below." />
          )}
          {active && active.length > 0 && (
            <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
              {active.map((r) => {
                const expires = r.expirationDate ? formatTemporal(r.expirationDate) : null;
                return (
                  <Link key={r.id} href={`/life/identity/${r.id}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-subtle">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-primary">{r.label}</p>
                      <p className="text-xs text-tertiary">{RECORD_TYPE_LABELS[r.recordType]}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {expires && <span className="text-xs text-tertiary">Expires {expires}</span>}
                      <Badge tone={r.status === "expired" ? "critical" : "neutral"}>{r.status === "expired" ? "Expired" : "Active"}</Badge>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}

      <AddIdentityRecordForm onAdded={() => mutate()} />
    </div>
  );
}
