"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

// Discriminated by `resourceType`, matching PublicShareService's own dispatch (services/api/src/modules/
// sharing/public-share.service.ts) — each variant is exactly the shape that resource's own
// `publicShareContent`/`publicPropertyContent`/`publicVehicleContent` method returns, plus the
// `resourceType` tag PublicShareService adds on top.
type DocumentShareResult = { resourceType: "document"; url: string; title: string };
type ListShareResult = { resourceType: "list"; name: string; kind: string; items: { label: string; checked: boolean }[] };
type PurchaseShareResult = {
  resourceType: "purchase";
  merchantName: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  lines: { productLabel: string; quantity: number; unitPriceMinorUnits: number | null; lineTotalMinorUnits: number | null; currency: string | null }[];
};
type MaintenanceRow = { description: string; serviceDate: TemporalValueLike; costMinorUnits: number | null; costCurrency: string | null };
type PropertyShareResult = { resourceType: "property"; label: string; propertyType: string; address: string | null; moveInDate: TemporalValueLike; maintenance: MaintenanceRow[] };
type VehicleShareResult = { resourceType: "vehicle"; label: string; make: string | null; model: string | null; year: number | null; purchaseDate: TemporalValueLike; maintenance: MaintenanceRow[] };
// SAVE-006 "notes... can stay private when base item is shared" — the API deliberately never returns
// userNotes on a public share link (the broadest possible exposure tier); see MemoriesService.
// publicShareContent's own doc comment.
type MemoryShareResult = { resourceType: "saved_memory"; title: string; category: string | null; sourceUrl: string | null };
type ShareResult = DocumentShareResult | ListShareResult | PurchaseShareResult | PropertyShareResult | VehicleShareResult | MemoryShareResult;

const RESOURCE_TITLE: Record<ShareResult["resourceType"], string> = {
  document: "Shared document",
  list: "Shared list",
  purchase: "Shared purchase",
  property: "Shared property",
  vehicle: "Shared vehicle",
  saved_memory: "Shared saved item",
};

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-002 "secure external link") — the recipient-facing page for
 * a share link. Deliberately outside the `(app)` route group (see its layout.tsx's auth redirect) so it
 * renders with no Veynlo session at all, matching the whole point of a public link.
 *
 * Generalized off a document-only page: object sharing now covers documents, lists, purchases,
 * properties, and vehicles (see SharingService's own doc comment), and a share-link token can resolve to
 * any of them — PublicShareService dispatches server-side and tags the response with `resourceType`; this
 * page just renders whichever variant it gets back, read-only, matching whatever the grant's scope
 * allows (view-only today — see resourceGrants.right's own schema comment on why "edit"/"manage" exist
 * but aren't used yet).
 */
export default function ShareLinkPage() {
  const { token } = useParams<{ token: string }>();
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShareResult | null>(null);

  // The server intentionally returns the same PASSCODE_REQUIRED code whether no passcode was given yet or
  // a wrong one was just submitted (SharingService.resolveShareLink: distinguishing "wrong passcode" from
  // "bad/unknown token" would let an attacker enumerate valid tokens). That guarantee is about token
  // enumeration, not about hiding a wrong guess from someone already on the passcode-entry step for a link
  // that's already confirmed to exist — so it's safe for the client to tell a *retry* apart from the initial,
  // passcode-less load and show "Incorrect passcode" only then, without the server ever having to say so.
  async function attemptAccess(candidatePasscode?: string, isRetry?: boolean) {
    setError(null);
    try {
      const data = await api.post<ShareResult>(`/v1/share/${token}/access`, { passcode: candidatePasscode });
      setResult(data);
      setNeedsPasscode(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSCODE_REQUIRED") {
        setNeedsPasscode(true);
        // Found live: submitting a wrong passcode silently re-showed the exact same "needs a passcode"
        // prompt with no indication anything happened — the user had no way to tell a typo from a page bug.
        if (isRetry) setError("Incorrect passcode. Please try again.");
      } else {
        setError(err instanceof ApiError ? err.message : "This link is invalid or has expired.");
      }
    }
  }

  useEffect(() => {
    attemptAccess().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function submitPasscode(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await attemptAccess(passcode, true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-md">
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">{result ? RESOURCE_TITLE[result.resourceType] : "Shared with you"}</h1>

          {loading && <div className="h-9 animate-pulse rounded-lg bg-subtle" />}

          {!loading && result && <ShareResultView result={result} />}

          {!loading && needsPasscode && !result && (
            <form onSubmit={submitPasscode} className="space-y-3">
              <div>
                <Label htmlFor="share-passcode">This link needs a passcode</Label>
                <Input id="share-passcode" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
              </div>
              <FieldError>{error ?? undefined}</FieldError>
              <Button type="submit" loading={submitting} disabled={!passcode}>
                Unlock
              </Button>
            </form>
          )}

          {!loading && error && !needsPasscode && <p className="text-sm text-critical">{error}</p>}
        </CardBody>
      </Card>
    </div>
  );
}

function ShareResultView({ result }: { result: ShareResult }) {
  switch (result.resourceType) {
    case "document":
      return (
        <>
          <p className="text-sm text-secondary">{result.title}</p>
          <Button onClick={() => window.open(result.url, "_blank", "noopener,noreferrer")}>Open document</Button>
        </>
      );

    case "list": {
      const checkedCount = result.items.filter((i) => i.checked).length;
      return (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-primary">{result.name}</p>
            <Badge tone="neutral">{result.kind.replace("_", " ")}</Badge>
          </div>
          {result.items.length === 0 ? (
            <p className="text-sm text-tertiary">This list has no items yet.</p>
          ) : (
            <>
              <p className="text-xs text-tertiary">
                {checkedCount} of {result.items.length} checked
              </p>
              <ul className="space-y-1.5">
                {result.items.map((item, i) => (
                  <li key={i} className={`text-sm ${item.checked ? "text-tertiary line-through" : "text-primary"}`}>
                    {item.label}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      );
    }

    case "purchase": {
      const date = formatTemporal(result.purchaseDate);
      const total = formatMoneyMinorUnits(result.totalMinorUnits, result.totalCurrency);
      return (
        <div className="space-y-3">
          <p className="text-sm text-secondary">
            {result.merchantName ?? "Purchase"}
            {date ? ` — ${date}` : ""}
          </p>
          {total && <p className="text-sm font-medium text-primary">{total}</p>}
          {result.lines.length > 0 && (
            <ul className="divide-y divide-border-subtle">
              {result.lines.map((line, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-primary">
                    {line.quantity > 1 ? `${line.quantity}× ` : ""}
                    {line.productLabel}
                  </span>
                  {line.lineTotalMinorUnits != null && <span className="text-tertiary">{formatMoneyMinorUnits(line.lineTotalMinorUnits, line.currency)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }

    case "saved_memory":
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-primary">{result.title}</p>
            {result.category && <Badge tone="neutral">{result.category.replace(/_/g, " ")}</Badge>}
          </div>
          {result.sourceUrl && (
            <Button onClick={() => window.open(result.sourceUrl!, "_blank", "noopener,noreferrer")}>Open source</Button>
          )}
        </div>
      );

    case "property":
    case "vehicle": {
      const subtitle = result.resourceType === "property" ? [result.propertyType, result.address].filter(Boolean).join(" — ") : [result.year, result.make, result.model].filter(Boolean).join(" ");
      const dateLabel = formatTemporal(result.resourceType === "property" ? result.moveInDate : result.purchaseDate);
      return (
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium text-primary">{result.label}</p>
            {subtitle && <p className="text-xs text-tertiary">{subtitle}</p>}
            {dateLabel && <p className="text-xs text-tertiary">{result.resourceType === "property" ? "Moved in" : "Purchased"} {dateLabel}</p>}
          </div>
          {result.maintenance.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-tertiary">Maintenance history</p>
              <ul className="divide-y divide-border-subtle">
                {result.maintenance.map((m, i) => {
                  const mDate = formatTemporal(m.serviceDate);
                  const amount = formatMoneyMinorUnits(m.costMinorUnits, m.costCurrency);
                  return (
                    <li key={i} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span className="text-primary">
                        {m.description}
                        {mDate && <span className="ml-2 text-xs text-tertiary">{mDate}</span>}
                      </span>
                      {amount && <span className="text-tertiary">{amount}</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      );
    }
  }
}
