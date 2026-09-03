"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface WarrantyDetail {
  warranty: {
    id: string;
    productLabel: string;
    warrantyLengthMonths: number | null;
    expirationDate: TemporalValueLike;
    registrationConfirmed: boolean | null;
    propertyProfileId: string | null;
    vehicleProfileId: string | null;
    voidedAt: string | null;
  };
  evidence: Evidence | null;
}

interface PickableProfile {
  id: string;
  label: string;
}

/**
 * Phase 2 §52.2 "service/warranty/maintenance history" — the write path for
 * `warranties.propertyProfileId`/`.vehicleProfileId` (`PATCH .../link-asset` on
 * CommerceService.linkWarrantyToAsset). Deliberately property/vehicle only here — `homeAssetId` linking
 * (a specific appliance, not the whole property) is left for a future "link this warranty" action on the
 * property detail page's own home-assets list (apps/web/src/app/(app)/life/properties/[id]/page.tsx),
 * since there's no standalone `GET` list of a user's home assets across every property to source a picker
 * from here — only "this property's home assets," nested under that property's own detail endpoint. The
 * API itself already accepts `homeAssetId` (see LinkWarrantyToAssetDtoSchema); only this page's picker is
 * scoped down.
 */
function LinkAssetPanel({
  warranty,
  onLinked,
}: {
  warranty: WarrantyDetail["warranty"];
  onLinked: () => void;
}) {
  const { data: properties } = useSWR<PickableProfile[]>("/v1/properties", swrFetcher);
  const { data: vehicles } = useSWR<PickableProfile[]>("/v1/vehicles", swrFetcher);
  const [kind, setKind] = useState<"property" | "vehicle">(warranty.vehicleProfileId ? "vehicle" : "property");
  const [selectedId, setSelectedId] = useState(warranty.propertyProfileId ?? warranty.vehicleProfileId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentlyLinkedLabel =
    warranty.propertyProfileId != null
      ? (properties?.find((p) => p.id === warranty.propertyProfileId)?.label ?? "a property")
      : warranty.vehicleProfileId != null
        ? (vehicles?.find((v) => v.id === warranty.vehicleProfileId)?.label ?? "a vehicle")
        : null;

  async function saveLink() {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.put(`/v1/warranties/${warranty.id}/link-asset`, {
        propertyProfileId: kind === "property" ? selectedId : null,
        vehicleProfileId: kind === "vehicle" ? selectedId : null,
      });
      onLinked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link this warranty.");
    } finally {
      setSubmitting(false);
    }
  }

  async function clearLink() {
    setSubmitting(true);
    setError(null);
    try {
      await api.put(`/v1/warranties/${warranty.id}/link-asset`, { propertyProfileId: null, vehicleProfileId: null });
      onLinked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't clear this warranty's link.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-sm font-medium text-primary">Linked property or vehicle</p>
        {currentlyLinkedLabel ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-tertiary">
              Currently linked to <span className="text-primary">{currentlyLinkedLabel}</span>.
            </p>
            <button onClick={clearLink} disabled={submitting} className="text-sm text-critical-subtle-text hover:underline disabled:opacity-50">
              {submitting ? "Clearing…" : "Clear link"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-tertiary">Not linked to a property or vehicle yet.</p>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-xs text-tertiary">Type</label>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as "property" | "vehicle");
                setSelectedId("");
              }}
              className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="property">Property</option>
              <option value="vehicle">Vehicle</option>
            </select>
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-xs text-tertiary">{kind === "property" ? "Property" : "Vehicle"}</label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="">Choose one…</option>
              {(kind === "property" ? properties : vehicles)?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={saveLink}
            disabled={submitting || !selectedId}
            className="h-9 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand hover:bg-brand-hover disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save link"}
          </button>
        </div>
        {error && <p className="text-sm text-critical-subtle-text">{error}</p>}
      </CardBody>
    </Card>
  );
}

export default function WarrantyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<WarrantyDetail | null>(`/v1/warranties/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this warranty" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This warranty doesn't exist or you don't have access to it." />;

  const { warranty, evidence } = data;
  const expires = formatTemporal(warranty.expirationDate);
  const days = daysUntil(warranty.expirationDate);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{warranty.productLabel}</h1>
          {expires && <p className="mt-1 text-sm text-tertiary">Expires {expires}</p>}
        </div>
        {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
      </header>

      {/* CommerceService.resolveReturn sets this automatically when the return case for this exact
          purchase line resolves — see that method's own comment for why it's scoped to the specific line,
          not "any return anywhere on the same order." A banner, not a hard block on anything else this page
          shows: the warranty record itself is still real history, it just likely no longer applies. */}
      {warranty.voidedAt && (
        <div className="rounded-xl border border-warning-subtle bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-text">
          This product was returned on {new Date(warranty.voidedAt).toLocaleDateString()} — this warranty may no longer apply.
        </div>
      )}

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {warranty.warrantyLengthMonths != null && (
              <>
                <dt className="text-tertiary">Length</dt>
                <dd className="text-primary">{warranty.warrantyLengthMonths} months</dd>
              </>
            )}
            <dt className="text-tertiary">Registered</dt>
            <dd className="text-primary">{warranty.registrationConfirmed == null ? "Unknown" : warranty.registrationConfirmed ? "Yes" : "No"}</dd>
            {/* Property/vehicle detail pages link forward into their linked warranties, but this page had
                no way back — the only route was the browser's back button. §644 "detail pages include
                History" implies this should be navigable in both directions. */}
            {warranty.propertyProfileId && (
              <>
                <dt className="text-tertiary">Linked to</dt>
                <dd className="text-primary">
                  <Link href={`/life/properties/${warranty.propertyProfileId}`} className="text-brand hover:underline">
                    View property
                  </Link>
                </dd>
              </>
            )}
            {warranty.vehicleProfileId && (
              <>
                <dt className="text-tertiary">Linked to</dt>
                <dd className="text-primary">
                  <Link href={`/life/vehicles/${warranty.vehicleProfileId}`} className="text-brand hover:underline">
                    View vehicle
                  </Link>
                </dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <LinkAssetPanel warranty={warranty} onLinked={() => mutate()} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
