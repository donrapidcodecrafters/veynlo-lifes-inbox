"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";

interface LegacyReleasePacket {
  householdRoster?: { displayName: string; relationshipLabel: string | null; role: string }[];
  vehicles?: { label: string; make: string | null; model: string | null; year: number | null }[];
  properties?: { label: string; propertyType: string; address: string | null }[];
  pets?: { label: string; species: string | null; breed: string | null }[];
  identityRecords?: { recordType: string; label: string; issuingAuthority: string | null }[];
  documents?: { title: string; documentType: string }[];
  medicationsNotes?: string | null;
  emergencyInstructions?: string | null;
}

const SECTION_LABELS: Record<keyof LegacyReleasePacket, string> = {
  householdRoster: "Household roster",
  vehicles: "Vehicles",
  properties: "Properties",
  pets: "Pets",
  identityRecords: "Identity records",
  documents: "Documents",
  medicationsNotes: "Medications notes",
  emergencyInstructions: "Emergency instructions",
};

/**
 * §35 SHARE-006 — the trusted contact's redemption page for a legacy release link, reachable only after a
 * verified, two-operator release process actually finalized it (see LegacyReleaseService.finalizeRelease's
 * own doc comment). Outside the `(app)` route group, same reasoning as share/day-pass's own pages: the
 * recipient has no Veynlo session, and none is required.
 */
export default function LegacyReleasePage() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [packet, setPacket] = useState<LegacyReleasePacket | null>(null);

  useEffect(() => {
    api
      .post<LegacyReleasePacket>(`/v1/legacy-release-redeem/${token}`, {})
      .then(setPacket)
      .catch((err) => setError(err instanceof ApiError ? err.message : "This link is invalid."))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <Card className="w-full max-w-md">
        <CardBody className="space-y-4">
          <h1 className="text-lg font-semibold text-primary">Shared information</h1>
          {loading && <div className="h-9 animate-pulse rounded-lg bg-subtle" />}
          {!loading && error && <p className="text-sm text-critical">{error}</p>}
          {!loading && packet && (
            <div className="space-y-4">
              {(Object.keys(SECTION_LABELS) as Array<keyof LegacyReleasePacket>).map((key) => {
                const value = packet[key];
                if (value == null || (Array.isArray(value) && value.length === 0)) return null;
                return (
                  <div key={key}>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-tertiary">{SECTION_LABELS[key]}</p>
                    {typeof value === "string" ? (
                      <p className="whitespace-pre-wrap text-sm text-primary">{value}</p>
                    ) : (
                      <ul className="space-y-1 text-sm text-primary">
                        {(value as Record<string, unknown>[]).map((item, i) => (
                          <li key={i}>{Object.values(item).filter(Boolean).join(" — ")}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
