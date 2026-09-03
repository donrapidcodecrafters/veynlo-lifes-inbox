"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface TripRow {
  id: string;
  label: string | null;
  destinationLabel: string | null;
  startDate: TemporalValueLike | null;
  endDate: TemporalValueLike | null;
  status: string;
  segmentCount: number;
  disrupted: boolean;
}

/**
 * Phase 3 §26 "Travel & Reservations" (TRIP-001). Trips are normally auto-assembled from ingested
 * confirmation emails (see IngestionService.extractTripSegment / TripsService.clusterSegment) — this page
 * also offers the TRIP-001 "manual seed" fallback for planning ahead of any confirmation email.
 */
export default function TripsPage() {
  const { data: trips, error: tripsError, isLoading, mutate } = useSWR<TripRow[]>("/v1/trips", swrFetcher);
  const [destinationLabel, setDestinationLabel] = useState("");
  const [startDateIso, setStartDateIso] = useState("");
  const [endDateIso, setEndDateIso] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createTrip(e: FormEvent) {
    e.preventDefault();
    setError(null);
    // Neither this form nor the API validated that the end date isn't before the start date — confirmed
    // live: submitting Jan 2027 → Dec 2026 silently created a trip with an end date before its start,
    // which then rendered a nonsensical "Jan 1, 2027 – Dec 1, 2026" range on both this list and the trip
    // detail page. Same client-side-sanity-check pattern AddVehicleForm already uses for an invalid year.
    if (startDateIso && endDateIso && endDateIso < startDateIso) {
      setError("End date can't be before the start date.");
      return;
    }
    setCreating(true);
    try {
      await api.post("/v1/trips", { destinationLabel: destinationLabel || null, startDateIso: startDateIso || null, endDateIso: endDateIso || null });
      setDestinationLabel("");
      setStartDateIso("");
      setEndDateIso("");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create that trip.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Trips</h1>
        <p className="mt-1 text-sm text-tertiary">
          Auto-assembled from your flight, lodging, rental, and ticket confirmations — or start one yourself before you have any confirmations yet.
        </p>
      </header>

      <Card>
        <CardBody>
          <form onSubmit={createTrip} className="space-y-3">
            <div>
              <Label htmlFor="trip-destination">Start a trip</Label>
              <Input id="trip-destination" placeholder="Destination, e.g. Lisbon" value={destinationLabel} onChange={(e) => setDestinationLabel(e.target.value)} maxLength={200} />
            </div>
            <div className="flex flex-wrap gap-3">
              <div>
                <Label htmlFor="trip-start">Start date</Label>
                <Input id="trip-start" type="date" value={startDateIso} onChange={(e) => setStartDateIso(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="trip-end">End date</Label>
                <Input id="trip-end" type="date" value={endDateIso} onChange={(e) => setEndDateIso(e.target.value)} />
              </div>
            </div>
            <FieldError>{error ?? undefined}</FieldError>
            <Button type="submit" loading={creating}>
              Create trip
            </Button>
          </form>
        </CardBody>
      </Card>

      {isLoading && <p className="text-sm text-tertiary">Loading…</p>}

      {!isLoading && tripsError && !trips && (
        <FetchError what="your trips" message={tripsError instanceof ApiError ? tripsError.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !tripsError && (trips ?? []).length === 0 && (
        <EmptyState title="No trips yet" description="Trips appear automatically once a flight, hotel, rental, or ticket confirmation arrives — or create one above." />
      )}

      {(trips ?? []).length > 0 && (
        <div className="space-y-3">
          {trips!.map((trip) => (
            <Link key={trip.id} href={`/trips/${trip.id}`}>
              <Card className="transition-colors hover:bg-subtle">
                <CardBody className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-[0.9375rem] font-medium text-primary">{trip.label ?? trip.destinationLabel ?? "Trip"}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {trip.destinationLabel && <Badge tone="neutral">{trip.destinationLabel}</Badge>}
                      <Badge tone={trip.status === "cancelled" ? "critical" : "neutral"}>{trip.status}</Badge>
                      {trip.disrupted && <Badge tone="critical">Disruption</Badge>}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-sm text-tertiary">
                    <p>{formatTemporal(trip.startDate) ?? "Dates TBD"}</p>
                    <p>
                      {trip.segmentCount} segment{trip.segmentCount === 1 ? "" : "s"}
                    </p>
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
