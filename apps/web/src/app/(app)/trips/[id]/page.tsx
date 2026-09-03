"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import { FetchError } from "@/components/ui/fetch-error";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatTemporal, formatMoneyMinorUnits, type TemporalValueLike } from "@/lib/format";
import { REMINDER_OPTIONS } from "@/lib/calendar-destinations";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";

interface TripSegmentDetails {
  baggageInfo?: string | null;
  feesInfo?: string | null;
  bookingUrl?: string | null;
}

interface TripSegment {
  id: string;
  kind: "flight" | "lodging" | "rental" | "ticket";
  providerName: string | null;
  confirmationNumber: string | null;
  locationLabel: string | null;
  startAt: TemporalValueLike | null;
  endAt: TemporalValueLike | null;
  status: string;
  disruptionStatus: string;
  disruptionNote: string | null;
  policyEvidenceText: string | null;
  cancellationDeadline: TemporalValueLike | null;
  detailsJson: TripSegmentDetails;
  checkInReminderMinutesBefore: number | null;
  updatedAt: string;
}

interface TravelCredit {
  id: string;
  providerName: string | null;
  amountMinorUnits: number;
  currency: string;
  expirationDate: TemporalValueLike | null;
  redeemed: boolean;
}

interface DocumentReadinessRow {
  documentId: string;
  title: string;
  severity: "expires_before_trip" | "expires_soon_after_trip";
}

interface TripDetail {
  trip: {
    id: string;
    label: string | null;
    destinationLabel: string | null;
    startDate: TemporalValueLike | null;
    endDate: TemporalValueLike | null;
    status: string;
    packingListId: string | null;
    travelerUserIds: string[];
  };
  segments: TripSegment[];
  credits: TravelCredit[];
  documentReadiness: DocumentReadinessRow[];
  sharingState: string;
  disrupted: boolean;
  suggestedMergeTrips: Array<{ id: string; label: string | null; destinationLabel: string | null; startDate: TemporalValueLike | null; endDate: TemporalValueLike | null }>;
}

const KIND_LABEL: Record<TripSegment["kind"], string> = { flight: "Flight", lodging: "Lodging", rental: "Rental / transport", ticket: "Ticket" };
const SEGMENT_KIND_OPTIONS: Array<{ value: TripSegment["kind"]; label: string }> = [
  { value: "flight", label: KIND_LABEL.flight },
  { value: "lodging", label: KIND_LABEL.lodging },
  { value: "rental", label: KIND_LABEL.rental },
  { value: "ticket", label: KIND_LABEL.ticket },
];

function disruptionLabel(status: string): string | null {
  if (status === "cancelled") return "Cancelled";
  if (status === "delayed") return "Delayed";
  if (status === "changed") return "Schedule changed";
  return null;
}

/** TRIP-005 — best-effort provider label from a booking URL's hostname, e.g. "https://www.united.com/..."
 * -> "united.com". Never guesses a brand name beyond the literal domain. */
function providerFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "provider";
  }
}

export default function TripDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error: fetchError, isLoading, mutate } = useSWR<TripDetail>(`/v1/trips/${id}`, swrFetcher);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);

  async function confirmMerge(sourceTripId: string) {
    setMerging(sourceTripId);
    setError(null);
    try {
      await api.post(`/v1/trips/${id}/merge`, { sourceTripId });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't merge those trips.");
    } finally {
      setMerging(null);
    }
  }

  async function redeemCredit(creditId: string) {
    setError(null);
    try {
      await api.post(`/v1/trips/credits/${creditId}/redeem`);
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark that credit used.");
    }
  }

  if (isLoading) return <p className="text-sm text-tertiary">Loading…</p>;
  // A failed GET previously fell straight through to the same "not found" copy as a genuinely
  // missing trip, which reads as data loss instead of a retryable network/server hiccup — the
  // exact gap the FetchError sweep already closed on the other Life detail pages (pets/vehicles/
  // properties) and the trips/saved list pages. Mirror that fix here.
  if (fetchError && !data) {
    return (
      <div className="space-y-6">
        <Link href="/trips" className="text-sm text-tertiary hover:underline">
          ← Trips
        </Link>
        <FetchError what="this trip" message={fetchError instanceof ApiError ? fetchError.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <p className="text-sm text-tertiary">Trip not found.</p>;

  const { trip, segments, credits, documentReadiness, disrupted, suggestedMergeTrips } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/trips" className="text-sm text-tertiary hover:underline">
            ← Trips
          </Link>
          <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-primary">{trip.label ?? trip.destinationLabel ?? "Trip"}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {trip.destinationLabel && <Badge tone="neutral">{trip.destinationLabel}</Badge>}
            <Badge tone={trip.status === "cancelled" ? "critical" : "neutral"}>{trip.status}</Badge>
            <span className="text-sm text-tertiary">
              {formatTemporal(trip.startDate) ?? "?"} – {formatTemporal(trip.endDate) ?? "?"}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {trip.packingListId && (
            <Link href={`/lists/${trip.packingListId}`} className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle">
              Packing list →
            </Link>
          )}
          <Button variant="secondary" onClick={() => setSharing((s) => !s)}>
            Share
          </Button>
        </div>
      </div>

      <FieldError>{error ?? undefined}</FieldError>

      {/* TRIP-009 disruption mode — notification-only elevation, never real rebooking (see
          docs/PHASE3_PENDING_CREDENTIALS.md). */}
      {disrupted && (
        <Card className="border-critical">
          <CardBody>
            <p className="text-sm font-medium text-critical-subtle-text">A reservation on this trip has changed</p>
            <p className="mt-1 text-sm text-tertiary">Review the affected segment below and contact the provider directly if you need to rebook — Veynlo doesn&apos;t book travel on your behalf.</p>
          </CardBody>
        </Card>
      )}

      {/* TRIP-001 "asks when confidence is weak" — ambiguous clustering candidates, never auto-merged. */}
      {suggestedMergeTrips.length > 0 && (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-medium text-primary">Is this the same trip as one of these?</p>
            {suggestedMergeTrips.map((candidate) => (
              <div key={candidate.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-default p-3">
                <div className="min-w-0 text-sm">
                  <p className="break-words font-medium text-primary">{candidate.label ?? candidate.destinationLabel ?? "Trip"}</p>
                  <p className="text-tertiary">
                    {formatTemporal(candidate.startDate) ?? "?"} – {formatTemporal(candidate.endDate) ?? "?"}
                  </p>
                </div>
                <Button variant="secondary" className="shrink-0" loading={merging === candidate.id} onClick={() => confirmMerge(candidate.id)}>
                  Merge
                </Button>
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      {/* TRIP-006 — never invents a visa/entry rule, only a "verify yourself" reminder. */}
      {documentReadiness.length > 0 && (
        <Card className="border-warning">
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Travel document check</p>
            {documentReadiness.map((doc) => (
              <p key={doc.documentId} className="text-sm text-tertiary">
                {doc.severity === "expires_before_trip"
                  ? `${doc.title} expires before this trip ends — verify entry requirements for your destination.`
                  : `${doc.title} expires soon after this trip — many destinations expect passport validity well beyond your travel dates; verify entry requirements for your destination.`}
              </p>
            ))}
          </CardBody>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-primary">Segments</h2>
        {segments.length === 0 && <p className="text-sm text-tertiary">No segments yet.</p>}
        {segments.map((seg) => (
          <SegmentCard key={seg.id} segment={seg} onChanged={() => mutate()} />
        ))}
        <AddSegmentForm tripId={String(id)} onAdded={() => mutate()} />
      </section>

      {credits.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-primary">Credits &amp; vouchers</h2>
          {credits.map((credit) => (
            <Card key={credit.id}>
              <CardBody className="flex items-center justify-between gap-3">
                <div className="min-w-0 text-sm">
                  <p className="break-words font-medium text-primary">
                    {credit.providerName ?? "Travel"} — {formatMoneyMinorUnits(credit.amountMinorUnits, credit.currency)}
                  </p>
                  {credit.expirationDate && <p className="text-tertiary">Expires {formatTemporal(credit.expirationDate)}</p>}
                </div>
                {credit.redeemed ? <Badge tone="positive">Used</Badge> : (
                  <Button variant="secondary" className="shrink-0" onClick={() => redeemCredit(credit.id)}>
                    Mark used
                  </Button>
                )}
              </CardBody>
            </Card>
          ))}
        </section>
      )}

      {sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/trips" resourceLabel="trip" />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/**
 * Manual "Add segment" — trips previously had no way to record a flight/lodging/rental/ticket that wasn't
 * auto-discovered from email. Mirrors AddVehicleForm/AddPetForm's identical collapsed-link -> inline-card
 * shape (life/page.tsx): a `kind` select plus the common fields, then only the kind-specific fields the
 * backend (`POST /v1/trips/{tripId}/segments`) actually accepts for that kind — no giant undifferentiated
 * field dump for every kind at once.
 */
function AddSegmentForm({ tripId, onAdded }: { tripId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TripSegment["kind"]>("flight");
  const [providerName, setProviderName] = useState("");
  const [confirmationNumber, setConfirmationNumber] = useState("");
  const [locationLabel, setLocationLabel] = useState("");
  const [startDateIso, setStartDateIso] = useState("");
  const [endDateIso, setEndDateIso] = useState("");
  const [bookingUrl, setBookingUrl] = useState("");
  // flight-only
  const [flightNumber, setFlightNumber] = useState("");
  const [departureAirport, setDepartureAirport] = useState("");
  const [arrivalAirport, setArrivalAirport] = useState("");
  const [seat, setSeat] = useState("");
  // lodging-only
  const [propertyName, setPropertyName] = useState("");
  const [roomType, setRoomType] = useState("");
  const [guestCount, setGuestCount] = useState("");
  // rental-only
  const [vehicleOrServiceType, setVehicleOrServiceType] = useState("");
  const [pickupLocation, setPickupLocation] = useState("");
  const [dropoffLocation, setDropoffLocation] = useState("");
  // ticket-only
  const [eventName, setEventName] = useState("");
  const [venue, setVenue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setKind("flight");
    setProviderName("");
    setConfirmationNumber("");
    setLocationLabel("");
    setStartDateIso("");
    setEndDateIso("");
    setBookingUrl("");
    setFlightNumber("");
    setDepartureAirport("");
    setArrivalAirport("");
    setSeat("");
    setPropertyName("");
    setRoomType("");
    setGuestCount("");
    setVehicleOrServiceType("");
    setPickupLocation("");
    setDropoffLocation("");
    setEventName("");
    setVenue("");
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a segment
      </button>
    );
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/trips/${tripId}/segments`, {
        kind,
        providerName: providerName || undefined,
        confirmationNumber: confirmationNumber || undefined,
        locationLabel: locationLabel || undefined,
        startDateIso: startDateIso || undefined,
        endDateIso: endDateIso || undefined,
        bookingUrl: bookingUrl || undefined,
        ...(kind === "flight"
          ? {
              flightNumber: flightNumber || undefined,
              departureAirport: departureAirport || undefined,
              arrivalAirport: arrivalAirport || undefined,
              seat: seat || undefined,
            }
          : {}),
        ...(kind === "lodging"
          ? {
              propertyName: propertyName || undefined,
              roomType: roomType || undefined,
              guestCount: guestCount.trim() ? Number(guestCount) : undefined,
            }
          : {}),
        ...(kind === "rental"
          ? {
              vehicleOrServiceType: vehicleOrServiceType || undefined,
              pickupLocation: pickupLocation || undefined,
              dropoffLocation: dropoffLocation || undefined,
            }
          : {}),
        ...(kind === "ticket"
          ? {
              eventName: eventName || undefined,
              venue: venue || undefined,
            }
          : {}),
      });
      reset();
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that segment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as TripSegment["kind"])}
            aria-label="Segment type"
            className="h-10 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
          >
            {SEGMENT_KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="Provider (airline, hotel, company)" className="min-w-[180px] flex-1" />
          <Input value={confirmationNumber} onChange={(e) => setConfirmationNumber(e.target.value)} placeholder="Confirmation #" className="min-w-[140px]" />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40 shrink-0">
            <Input type="date" value={startDateIso} onChange={(e) => setStartDateIso(e.target.value)} aria-label="Start date" />
          </div>
          <div className="w-40 shrink-0">
            <Input type="date" value={endDateIso} onChange={(e) => setEndDateIso(e.target.value)} aria-label="End date" />
          </div>
          <Input value={locationLabel} onChange={(e) => setLocationLabel(e.target.value)} placeholder="Location (airport, address, city, venue)" className="min-w-[200px] flex-1" />
        </div>

        {kind === "flight" && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
            <Input value={flightNumber} onChange={(e) => setFlightNumber(e.target.value)} placeholder="Flight number" className="min-w-[120px]" />
            <Input value={departureAirport} onChange={(e) => setDepartureAirport(e.target.value)} placeholder="Departure airport" className="min-w-[140px]" />
            <Input value={arrivalAirport} onChange={(e) => setArrivalAirport(e.target.value)} placeholder="Arrival airport" className="min-w-[140px]" />
            <Input value={seat} onChange={(e) => setSeat(e.target.value)} placeholder="Seat (optional)" className="w-28" />
          </div>
        )}
        {kind === "lodging" && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
            <Input value={propertyName} onChange={(e) => setPropertyName(e.target.value)} placeholder="Property name" className="min-w-[160px] flex-1" />
            <Input value={roomType} onChange={(e) => setRoomType(e.target.value)} placeholder="Room type (optional)" className="min-w-[140px]" />
            <div className="w-24 shrink-0">
              <Input value={guestCount} onChange={(e) => setGuestCount(e.target.value)} placeholder="Guests" inputMode="numeric" />
            </div>
          </div>
        )}
        {kind === "rental" && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
            <Input value={vehicleOrServiceType} onChange={(e) => setVehicleOrServiceType(e.target.value)} placeholder="Vehicle / service type" className="min-w-[160px] flex-1" />
            <Input value={pickupLocation} onChange={(e) => setPickupLocation(e.target.value)} placeholder="Pickup location" className="min-w-[140px]" />
            <Input value={dropoffLocation} onChange={(e) => setDropoffLocation(e.target.value)} placeholder="Drop-off location (optional)" className="min-w-[140px]" />
          </div>
        )}
        {kind === "ticket" && (
          <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
            <Input value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="Event name" className="min-w-[160px] flex-1" />
            <Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Venue (optional)" className="min-w-[140px]" />
          </div>
        )}

        <Input value={bookingUrl} onChange={(e) => setBookingUrl(e.target.value)} placeholder="Booking confirmation URL (optional)" />

        <div className="flex items-center gap-2">
          <Button onClick={submit} loading={submitting}>
            Add segment
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/**
 * One trip segment's card, plus its four spec-named user actions: "Open confirmation" (evidence),
 * "Add calendar", "Set check-in reminder" (flight/lodging only), and TRIP-005's ticket deep-link. Split out
 * of the parent map so each segment's own evidence/calendar/reminder state (loading, saved, errors) stays
 * independent of its siblings.
 */
function SegmentCard({ segment: seg, onChanged }: { segment: TripSegment; onChanged: () => void }) {
  const disruption = disruptionLabel(seg.disruptionStatus);
  const [evidence, setEvidence] = useState<Evidence | null | undefined>(undefined); // undefined = not yet opened
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [calendarState, setCalendarState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [calendarReminder, setCalendarReminder] = useState(60);
  const [checkInReminder, setCheckInReminder] = useState<number | null>(seg.checkInReminderMinutesBefore);
  const [checkInSaving, setCheckInSaving] = useState(false);
  const [checkInSaved, setCheckInSaved] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);

  const canCheckIn = seg.kind === "flight" || seg.kind === "lodging";
  const bookingUrl = seg.detailsJson?.bookingUrl ?? null;
  const baggageInfo = seg.detailsJson?.baggageInfo ?? null;
  const feesInfo = seg.detailsJson?.feesInfo ?? null;

  async function toggleEvidence() {
    if (evidence !== undefined) {
      setEvidence(undefined); // collapse — re-fetches fresh next time it's opened
      return;
    }
    setEvidenceError(null);
    try {
      const result = await api.get<Evidence | null>(`/v1/trips/segments/${seg.id}/evidence`);
      setEvidence(result);
    } catch (err) {
      setEvidenceError(err instanceof ApiError ? err.message : "Couldn't load the source email for this segment.");
    }
  }

  async function addToCalendar() {
    setCalendarState("saving");
    try {
      await api.post(`/v1/trips/segments/${seg.id}/calendar`, { reminderMinutesBefore: calendarReminder });
      setCalendarState("done");
    } catch {
      setCalendarState("error");
    }
  }

  async function saveCheckInReminder(value: number | null) {
    setCheckInReminder(value);
    setCheckInSaving(true);
    setCheckInError(null);
    try {
      await api.put(`/v1/trips/segments/${seg.id}/check-in-reminder`, { checkInReminderMinutesBefore: value });
      setCheckInSaved(true);
      setTimeout(() => setCheckInSaved(false), 2000);
      onChanged();
    } catch (err) {
      setCheckInError(err instanceof ApiError ? err.message : "Couldn't save that reminder.");
    } finally {
      setCheckInSaving(false);
    }
  }

  return (
    <Card className={disruption ? "border-critical" : undefined}>
      <CardBody className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="break-words text-[0.9375rem] font-medium text-primary">
              {KIND_LABEL[seg.kind]}
              {seg.providerName ? ` — ${seg.providerName}` : ""}
            </p>
            <p className="break-words text-sm text-tertiary">{seg.locationLabel ?? "Location unknown"}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {disruption && <Badge tone="critical">{disruption}</Badge>}
            {seg.status === "cancelled" && <Badge tone="critical">Cancelled</Badge>}
          </div>
        </div>
        <p className="text-sm text-tertiary">
          {formatTemporal(seg.startAt) ?? "Date TBD"}
          {seg.endAt ? ` – ${formatTemporal(seg.endAt)}` : ""}
        </p>
        {seg.confirmationNumber && <p className="text-xs text-tertiary">Confirmation: {seg.confirmationNumber}</p>}
        {seg.cancellationDeadline && <p className="text-xs text-tertiary">Cancel/change by: {formatTemporal(seg.cancellationDeadline)}</p>}
        {/* TRIP-002 baggage — only ever shown when the source email literally stated it, never inferred. */}
        {seg.kind === "flight" && baggageInfo && <p className="text-xs text-tertiary">Baggage: {baggageInfo}</p>}
        {/* TRIP-003 fees — only ever shown when the source email literally stated it. */}
        {seg.kind === "lodging" && feesInfo && <p className="text-xs text-tertiary">Fees: {feesInfo}</p>}
        {seg.policyEvidenceText && <p className="text-xs text-tertiary italic">&ldquo;{seg.policyEvidenceText}&rdquo;</p>}
        {disruption && seg.disruptionNote && <p className="text-sm text-critical-subtle-text">{seg.disruptionNote}</p>}
        {/* TRIP-002 "email-only mode labels last confirmed information and freshness" — flight segments only
            (spec-named); there's no live status feed behind this, so `updatedAt` is the honest answer to
            "how stale might this be." */}
        {seg.kind === "flight" && <p className="text-xs text-tertiary">Last confirmed: {new Date(seg.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>}
        {/* TRIP-005 — a safe deep-link-out to the provider's own booking page; never an attempted
            barcode/ticket render (see this field's own doc comment on packages/db's travel.ts). */}
        {bookingUrl && (
          <a href={bookingUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-xs font-medium text-accent hover:underline">
            View on {providerFromUrl(bookingUrl)} →
          </a>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={toggleEvidence}>
            {evidence !== undefined ? "Hide confirmation" : "Open confirmation"}
          </Button>
          {calendarState === "done" ? (
            <Badge tone="positive">Added to calendar</Badge>
          ) : (
            <>
              <Button size="sm" variant="secondary" loading={calendarState === "saving"} onClick={addToCalendar}>
                Add calendar
              </Button>
              <select
                aria-label="Calendar reminder lead time"
                value={calendarReminder}
                onChange={(e) => setCalendarReminder(Number(e.target.value))}
                className="h-8 rounded-lg border border-border-subtle bg-surface px-2 text-xs text-primary"
              >
                {REMINDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        {calendarState === "error" && <FieldError>Couldn&apos;t add that to your calendar. Please try again.</FieldError>}

        {canCheckIn && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label htmlFor={`${seg.id}-checkin`} className="text-xs text-tertiary">
              Check-in reminder
            </label>
            <select
              id={`${seg.id}-checkin`}
              value={checkInReminder ?? ""}
              onChange={(e) => saveCheckInReminder(e.target.value === "" ? null : Number(e.target.value))}
              disabled={checkInSaving}
              className="h-8 rounded-lg border border-border-subtle bg-surface px-2 text-xs text-primary"
            >
              <option value="">Off</option>
              {REMINDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {checkInSaved && <span className="text-xs text-tertiary">Saved</span>}
          </div>
        )}
        {checkInError && <FieldError>{checkInError}</FieldError>}

        {evidence !== undefined && (
          <div className="pt-1">
            {evidenceError ? <FieldError>{evidenceError}</FieldError> : <EvidenceCard evidence={evidence} />}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
