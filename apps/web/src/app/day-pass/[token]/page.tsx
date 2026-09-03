"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";

interface DayPassPacket {
  label: string;
  householdName: string;
  expiresAt: string;
  instructions?: string | null;
  contacts?: { displayName: string; relationshipLabel: string | null }[];
  schedule?: { title: string; startSort: string | null; isAllDay: boolean }[];
  pets?: { label: string; species: string | null; breed: string | null; medications: string[] }[];
  dependents?: { displayName: string }[];
}

/**
 * §35 SHARE-005 "Caregiver/day pass" — the recipient-facing page for a day pass token, mirroring
 * apps/web/share/[token]/page.tsx's own passcode-retry UX exactly (same reasoning: an unknown token and a
 * wrong passcode look identical until you're already past the "does this exist" step). Outside the `(app)`
 * route group so it renders with no Veynlo session — a babysitter/house-sitter isn't expected to have one.
 */
export default function DayPassPage() {
  const { token } = useParams<{ token: string }>();
  const [passcode, setPasscode] = useState("");
  const [needsPasscode, setNeedsPasscode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packet, setPacket] = useState<DayPassPacket | null>(null);

  async function attemptAccess(candidatePasscode?: string, isRetry?: boolean) {
    setError(null);
    try {
      const data = await api.post<DayPassPacket>(`/v1/day-passes/${token}/access`, { passcode: candidatePasscode });
      setPacket(data);
      setNeedsPasscode(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSCODE_REQUIRED") {
        setNeedsPasscode(true);
        if (isRetry) setError("Incorrect passcode. Please try again.");
      } else {
        setError(err instanceof ApiError ? err.message : "This pass is invalid or has expired.");
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
          <h1 className="text-lg font-semibold text-primary">{packet ? packet.label : "Caregiver pass"}</h1>

          {loading && <div className="h-9 animate-pulse rounded-lg bg-subtle" />}

          {!loading && packet && <DayPassPacketView packet={packet} />}

          {!loading && needsPasscode && !packet && (
            <form onSubmit={submitPasscode} className="space-y-3">
              <div>
                <Label htmlFor="day-pass-passcode">This pass needs a passcode</Label>
                <Input id="day-pass-passcode" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoFocus />
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

function DayPassPacketView({ packet }: { packet: DayPassPacket }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-tertiary">
        For the {packet.householdName} household — valid until {new Date(packet.expiresAt).toLocaleString()}
      </p>

      {packet.instructions && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-tertiary">Access instructions</p>
          <p className="whitespace-pre-wrap text-sm text-primary">{packet.instructions}</p>
        </div>
      )}

      {packet.contacts && packet.contacts.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-tertiary">Contacts</p>
          <ul className="space-y-1 text-sm text-primary">
            {packet.contacts.map((c, i) => (
              <li key={i}>
                {c.displayName}
                {c.relationshipLabel ? ` (${c.relationshipLabel})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {packet.schedule && packet.schedule.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-tertiary">Schedule</p>
          <ul className="space-y-1 text-sm text-primary">
            {packet.schedule.map((e, i) => (
              <li key={i}>
                {e.title}
                {e.startSort && !e.isAllDay ? ` — ${new Date(e.startSort).toLocaleString()}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {packet.pets && packet.pets.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-tertiary">Pets</p>
          <ul className="space-y-1 text-sm text-primary">
            {packet.pets.map((p, i) => (
              <li key={i}>
                {p.label}
                {[p.species, p.breed].filter(Boolean).length > 0 ? ` (${[p.species, p.breed].filter(Boolean).join(", ")})` : ""}
                {p.medications.length > 0 && <span className="block text-xs text-tertiary">Medications: {p.medications.join(", ")}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {packet.dependents && packet.dependents.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-tertiary">Kids</p>
          <ul className="space-y-1 text-sm text-primary">
            {packet.dependents.map((d, i) => (
              <li key={i}>{d.displayName}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
