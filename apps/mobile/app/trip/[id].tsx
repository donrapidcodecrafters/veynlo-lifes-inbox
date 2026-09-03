import { useCallback, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { ScreenHeader } from "@/components/screen-header";
import { EmptyState } from "@/components/empty-state";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
import { formatTemporal, formatMoneyMinorUnits, type TemporalValueLike } from "@/lib/format";
import { REMINDER_OPTIONS } from "@/lib/calendar-destinations";
import { tripOfflineCache } from "@/lib/trip-offline-cache";
import { useAuth } from "@/lib/auth-context";

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
  trip: { id: string; label: string | null; destinationLabel: string | null; startDate: TemporalValueLike | null; endDate: TemporalValueLike | null; status: string; packingListId: string | null };
  segments: TripSegment[];
  credits: TravelCredit[];
  documentReadiness: DocumentReadinessRow[];
  disrupted: boolean;
  suggestedMergeTrips: Array<{ id: string; label: string | null; destinationLabel: string | null; startDate: TemporalValueLike | null; endDate: TemporalValueLike | null }>;
}

const KIND_LABEL: Record<TripSegment["kind"], string> = { flight: "Flight", lodging: "Lodging", rental: "Rental / transport", ticket: "Ticket" };

function disruptionLabel(status: string): string | null {
  if (status === "cancelled") return "Cancelled";
  if (status === "delayed") return "Delayed";
  if (status === "changed") return "Schedule changed";
  return null;
}

function providerFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "provider";
  }
}

export default function TripDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [data, setData] = useState<TripDetail | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<TripDetail | null>(`/v1/trips/${id}`)
      .then(async (result) => {
        setData(result);
        setOffline(false);
        if (result && user?.id) await tripOfflineCache.set(String(id), result, user.id);
      })
      .catch(async (err) => {
        if (err instanceof ApiError && err.status === 404) {
          setData(null);
          return;
        }
        // Same offline-cache fallback pattern as emergency-binder.tsx — a real network failure (not a
        // legitimate 404) falls back to the last-fetched copy of THIS trip, tagged to and re-checked
        // against the currently signed-in user so a stale cross-account cache can't surface.
        const cached = user?.id ? await tripOfflineCache.get(String(id), user.id) : null;
        if (cached) {
          setData(cached.payload as TripDetail);
          setOffline(true);
        } else {
          setError(err instanceof ApiError ? err.message : "Couldn't load this trip. Please try again.");
        }
      })
      .finally(() => setRetrying(false));
  }, [id, user?.id]);

  useFocusEffect(load);

  async function confirmMerge(sourceTripId: string) {
    setMerging(sourceTripId);
    setError(null);
    try {
      await api.post(`/v1/trips/${id}/merge`, { sourceTripId });
      load();
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
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark that credit used.");
    }
  }

  // A real fetch failure with no offline cache to fall back on (see `load` above) left `data` stuck
  // at `undefined` forever with no way out — the skeleton below rendered permanently and `error` was
  // never shown, since it's only read inside the "loaded" branch further down. pet/vehicle/property
  // detail screens already guard on `error` before the loading check for exactly this reason; mirror
  // that here.
  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this trip"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Trip" />
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (data === null) {
    return (
      <Screen>
        <ScreenHeader title="Trip" />
        <EmptyState title="Trip not found" description={error ?? "This trip doesn't exist or you don't have access to it."} />
      </Screen>
    );
  }

  const { trip, segments, credits, documentReadiness, disrupted, suggestedMergeTrips } = data;

  return (
    <Screen>
      <ScreenHeader title={trip.label ?? trip.destinationLabel ?? "Trip"} subtitle={`${formatTemporal(trip.startDate) ?? "?"} – ${formatTemporal(trip.endDate) ?? "?"}`} />

      {offline && (
        <Card style={{ borderColor: theme.colors.warningSubtleBg, borderWidth: 1 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Showing the last saved copy of this trip — you appear to be offline.</Text>
        </Card>
      )}
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}

      {disrupted && (
        <Card style={{ borderColor: theme.colors.criticalSubtleBg, borderWidth: 1, gap: 4 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.criticalSubtleText }}>A reservation on this trip has changed</Text>
          <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Review the affected segment below and contact the provider directly if you need to rebook — Veynlo doesn&apos;t book travel on your behalf.</Text>
        </Card>
      )}

      {suggestedMergeTrips.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Is this the same trip as one of these?</Text>
          {suggestedMergeTrips.map((candidate) => (
            <View key={candidate.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>{candidate.label ?? candidate.destinationLabel ?? "Trip"}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                  {formatTemporal(candidate.startDate) ?? "?"} – {formatTemporal(candidate.endDate) ?? "?"}
                </Text>
              </View>
              <Button variant="secondary" loading={merging === candidate.id} onPress={() => confirmMerge(candidate.id)}>
                Merge
              </Button>
            </View>
          ))}
        </Card>
      )}

      {documentReadiness.length > 0 && (
        <Card style={{ borderColor: theme.colors.warningSubtleBg, borderWidth: 1, gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Travel document check</Text>
          {documentReadiness.map((doc) => (
            <Text key={doc.documentId} style={{ fontSize: 13, color: theme.colors.textSecondary }}>
              {doc.severity === "expires_before_trip"
                ? `${doc.title} expires before this trip ends — verify entry requirements for your destination.`
                : `${doc.title} expires soon after this trip — verify entry requirements for your destination.`}
            </Text>
          ))}
        </Card>
      )}

      {trip.packingListId && (
        <Button variant="secondary" onPress={() => router.push(`/list/${trip.packingListId}`)}>
          Open packing list
        </Button>
      )}

      <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary, marginTop: 4 }}>Segments</Text>
      {segments.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No segments yet.</Text>}
      {segments.map((seg) => (
        <SegmentCard key={seg.id} segment={seg} onChanged={load} />
      ))}
      <AddSegmentRow tripId={String(id)} onAdded={load} />

      {credits.length > 0 && (
        <>
          <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary, marginTop: 4 }}>Credits &amp; vouchers</Text>
          {credits.map((credit) => (
            <Card key={credit.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View>
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>
                  {credit.providerName ?? "Travel"} — {formatMoneyMinorUnits(credit.amountMinorUnits, credit.currency)}
                </Text>
                {credit.expirationDate && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Expires {formatTemporal(credit.expirationDate)}</Text>}
              </View>
              {credit.redeemed ? <Badge tone="positive">Used</Badge> : (
                <Button variant="secondary" onPress={() => redeemCredit(credit.id)}>
                  Mark used
                </Button>
              )}
            </Card>
          ))}
        </>
      )}

      <Button variant="secondary" onPress={() => setSharing((s) => !s)}>
        {sharing ? "Hide sharing" : "Share this trip"}
      </Button>
      {sharing && <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/trips" resourceLabel="trip" />}
    </Screen>
  );
}

const SEGMENT_KIND_OPTIONS: Array<{ value: TripSegment["kind"]; label: string }> = [
  { value: "flight", label: "Flight" },
  { value: "lodging", label: "Lodging" },
  { value: "rental", label: "Rental or transport" },
  { value: "ticket", label: "Ticket" },
];

// Same underlying `locationLabel`/date fields for every kind (CreateManualTripSegmentDtoSchema, see
// services/api/src/modules/trips/dto.ts), but what they actually mean differs by kind — these labels/
// placeholders just steer the user toward the right thing to type into the same box.
const LOCATION_LABEL_LABEL: Record<TripSegment["kind"], string> = {
  flight: "Airport code(s)",
  lodging: "Hotel address",
  rental: "Pickup city",
  ticket: "Venue address",
};
const START_DATE_LABEL: Record<TripSegment["kind"], string> = {
  flight: "Departure date (YYYY-MM-DD)",
  lodging: "Check-in date (YYYY-MM-DD)",
  rental: "Pickup date (YYYY-MM-DD)",
  ticket: "Event date (YYYY-MM-DD)",
};
const END_DATE_LABEL: Record<TripSegment["kind"], string> = {
  flight: "Arrival date (optional, YYYY-MM-DD)",
  lodging: "Check-out date (YYYY-MM-DD)",
  rental: "Return date (optional, YYYY-MM-DD)",
  ticket: "End date (optional, YYYY-MM-DD)",
};

/** Manual "Add segment" — matches apps/web's identical form (trips/[id]/page.tsx) field-for-field against
 * `POST /v1/trips/{tripId}/segments`'s CreateManualTripSegmentDtoSchema. Every field but `kind` is
 * optional/nullable server-side (a user filling this in by hand may not know every detail), so nothing here
 * is required beyond picking a kind — mirrors the DTO's own "never require what isn't known" stance. */
function AddSegmentRow({ tripId, onAdded }: { tripId: string; onAdded: () => void }) {
  const { theme } = useAppTheme();
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
  const [baggageInfo, setBaggageInfo] = useState("");
  // lodging-only
  const [propertyName, setPropertyName] = useState("");
  const [roomType, setRoomType] = useState("");
  const [guestCount, setGuestCount] = useState("");
  const [feesInfo, setFeesInfo] = useState("");
  // rental-only
  const [vehicleOrServiceType, setVehicleOrServiceType] = useState("");
  const [pickupLocation, setPickupLocation] = useState("");
  const [dropoffLocation, setDropoffLocation] = useState("");
  // ticket-only
  const [eventName, setEventName] = useState("");
  const [venue, setVenue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a segment</Text>
      </Pressable>
    );
  }

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
    setBaggageInfo("");
    setPropertyName("");
    setRoomType("");
    setGuestCount("");
    setFeesInfo("");
    setVehicleOrServiceType("");
    setPickupLocation("");
    setDropoffLocation("");
    setEventName("");
    setVenue("");
  }

  async function submit() {
    const trimmedGuests = guestCount.trim();
    const parsedGuests = trimmedGuests ? Number(trimmedGuests) : null;
    if (trimmedGuests && (!Number.isInteger(parsedGuests) || parsedGuests! < 1 || parsedGuests! > 50)) {
      setError("Enter a valid number of guests (1–50), or leave it blank.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/trips/${tripId}/segments`, {
        kind,
        providerName: providerName.trim() || undefined,
        confirmationNumber: confirmationNumber.trim() || undefined,
        locationLabel: locationLabel.trim() || undefined,
        startDateIso: startDateIso.trim() || undefined,
        endDateIso: endDateIso.trim() || undefined,
        bookingUrl: bookingUrl.trim() || undefined,
        flightNumber: kind === "flight" ? flightNumber.trim() || undefined : undefined,
        departureAirport: kind === "flight" ? departureAirport.trim() || undefined : undefined,
        arrivalAirport: kind === "flight" ? arrivalAirport.trim() || undefined : undefined,
        seat: kind === "flight" ? seat.trim() || undefined : undefined,
        baggageInfo: kind === "flight" ? baggageInfo.trim() || undefined : undefined,
        propertyName: kind === "lodging" ? propertyName.trim() || undefined : undefined,
        roomType: kind === "lodging" ? roomType.trim() || undefined : undefined,
        guestCount: kind === "lodging" ? (parsedGuests ?? undefined) : undefined,
        feesInfo: kind === "lodging" ? feesInfo.trim() || undefined : undefined,
        vehicleOrServiceType: kind === "rental" ? vehicleOrServiceType.trim() || undefined : undefined,
        pickupLocation: kind === "rental" ? pickupLocation.trim() || undefined : undefined,
        dropoffLocation: kind === "rental" ? dropoffLocation.trim() || undefined : undefined,
        eventName: kind === "ticket" ? eventName.trim() || undefined : undefined,
        venue: kind === "ticket" ? venue.trim() || undefined : undefined,
      });
      reset();
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this segment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const chipStyle = (selected: boolean) => ({
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: selected ? theme.colors.brandDefault : theme.colors.borderDefault,
    backgroundColor: selected ? theme.colors.brandDefault : "transparent",
  });
  const chipTextStyle = (selected: boolean) => ({ fontSize: 12, fontWeight: "600" as const, color: selected ? theme.colors.textOnBrand : theme.colors.textPrimary });

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Kind</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {SEGMENT_KIND_OPTIONS.map((opt) => (
          <Pressable accessibilityRole="button" key={opt.value} onPress={() => setKind(opt.value)} style={chipStyle(kind === opt.value)}>
            <Text style={chipTextStyle(kind === opt.value)}>{opt.label}</Text>
          </Pressable>
        ))}
      </View>

      <TextField label="Provider name" placeholder="e.g. Delta, Marriott" value={providerName} onChangeText={setProviderName} />
      <TextField label="Confirmation number" value={confirmationNumber} onChangeText={setConfirmationNumber} />
      <TextField label={LOCATION_LABEL_LABEL[kind]} value={locationLabel} onChangeText={setLocationLabel} />
      <TextField label={START_DATE_LABEL[kind]} placeholder="2026-10-20" value={startDateIso} onChangeText={setStartDateIso} />
      <TextField label={END_DATE_LABEL[kind]} placeholder="2026-10-27" value={endDateIso} onChangeText={setEndDateIso} />

      {kind === "flight" && (
        <>
          <TextField label="Flight number" placeholder="e.g. DL123" value={flightNumber} onChangeText={setFlightNumber} autoCapitalize="characters" />
          <TextField label="Departure airport" placeholder="e.g. JFK" value={departureAirport} onChangeText={setDepartureAirport} autoCapitalize="characters" />
          <TextField label="Arrival airport" placeholder="e.g. LHR" value={arrivalAirport} onChangeText={setArrivalAirport} autoCapitalize="characters" />
          <TextField label="Seat (optional)" value={seat} onChangeText={setSeat} />
          <TextField label="Baggage info (optional)" value={baggageInfo} onChangeText={setBaggageInfo} />
        </>
      )}
      {kind === "lodging" && (
        <>
          <TextField label="Property name" value={propertyName} onChangeText={setPropertyName} />
          <TextField label="Room type (optional)" value={roomType} onChangeText={setRoomType} />
          <TextField label="Guests (optional)" value={guestCount} onChangeText={setGuestCount} keyboardType="number-pad" />
          <TextField label="Fees info (optional)" value={feesInfo} onChangeText={setFeesInfo} />
        </>
      )}
      {kind === "rental" && (
        <>
          <TextField label="Vehicle / service type" placeholder="e.g. Compact car, Uber" value={vehicleOrServiceType} onChangeText={setVehicleOrServiceType} />
          <TextField label="Pickup location" value={pickupLocation} onChangeText={setPickupLocation} />
          <TextField label="Dropoff location (optional)" value={dropoffLocation} onChangeText={setDropoffLocation} />
        </>
      )}
      {kind === "ticket" && (
        <>
          <TextField label="Event name" value={eventName} onChangeText={setEventName} />
          <TextField label="Venue" value={venue} onChangeText={setVenue} />
        </>
      )}

      <TextField label="Booking URL (optional)" value={bookingUrl} onChangeText={setBookingUrl} autoCapitalize="none" keyboardType="url" />

      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting}>
            Add segment
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button
            variant="secondary"
            onPress={() => {
              setOpen(false);
              reset();
            }}
          >
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

/** Mirrors apps/web's identical SegmentCard (trips/[id]/page.tsx) — see its own doc comment for the four
 * spec-named segment actions this renders. */
function SegmentCard({ segment: seg, onChanged }: { segment: TripSegment; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const disruption = disruptionLabel(seg.disruptionStatus);
  const [evidence, setEvidence] = useState<Evidence | null | undefined>(undefined);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [calendarState, setCalendarState] = useState<"idle" | "saving" | "done" | "error">("idle");
  const [calendarReminder, setCalendarReminder] = useState(60);
  const [checkInReminder, setCheckInReminder] = useState<number | null>(seg.checkInReminderMinutesBefore);
  const [checkInSaving, setCheckInSaving] = useState(false);
  const [checkInError, setCheckInError] = useState<string | null>(null);

  const canCheckIn = seg.kind === "flight" || seg.kind === "lodging";
  const bookingUrl = seg.detailsJson?.bookingUrl ?? null;
  const baggageInfo = seg.detailsJson?.baggageInfo ?? null;
  const feesInfo = seg.detailsJson?.feesInfo ?? null;

  async function toggleEvidence() {
    if (evidence !== undefined) {
      setEvidence(undefined);
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
      onChanged();
    } catch (err) {
      setCheckInError(err instanceof ApiError ? err.message : "Couldn't save that reminder.");
    } finally {
      setCheckInSaving(false);
    }
  }

  const chipStyle = (selected: boolean) => ({
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: selected ? theme.colors.brandDefault : theme.colors.borderDefault,
    backgroundColor: selected ? theme.colors.brandDefault : "transparent",
  });
  const chipTextStyle = (selected: boolean) => ({ fontSize: 12, fontWeight: "600" as const, color: selected ? theme.colors.textOnBrand : theme.colors.textPrimary });

  return (
    <Card style={disruption ? { borderColor: theme.colors.criticalSubtleBg, borderWidth: 1, gap: 4 } : { gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
            {KIND_LABEL[seg.kind]}
            {seg.providerName ? ` — ${seg.providerName}` : ""}
          </Text>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{seg.locationLabel ?? "Location unknown"}</Text>
        </View>
        {disruption && <Badge tone="critical">{disruption}</Badge>}
      </View>
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        {formatTemporal(seg.startAt) ?? "Date TBD"}
        {seg.endAt ? ` – ${formatTemporal(seg.endAt)}` : ""}
      </Text>
      {seg.confirmationNumber && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Confirmation: {seg.confirmationNumber}</Text>}
      {seg.kind === "flight" && baggageInfo && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Baggage: {baggageInfo}</Text>}
      {seg.kind === "lodging" && feesInfo && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Fees: {feesInfo}</Text>}
      {disruption && seg.disruptionNote && <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>{seg.disruptionNote}</Text>}
      {seg.kind === "flight" && (
        <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
          Last confirmed: {new Date(seg.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
        </Text>
      )}
      {bookingUrl && (
        <Pressable accessibilityRole="button" onPress={() => Linking.openURL(bookingUrl)}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault }}>View on {providerFromUrl(bookingUrl)} →</Text>
        </Pressable>
      )}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 4 }}>
        <Pressable accessibilityRole="button" onPress={toggleEvidence} style={chipStyle(evidence !== undefined)}>
          <Text style={chipTextStyle(evidence !== undefined)}>{evidence !== undefined ? "Hide confirmation" : "Open confirmation"}</Text>
        </Pressable>
        {calendarState === "done" ? (
          <Badge tone="positive">Added to calendar</Badge>
        ) : (
          <Pressable accessibilityRole="button" onPress={addToCalendar} disabled={calendarState === "saving"} style={chipStyle(false)}>
            <Text style={chipTextStyle(false)}>{calendarState === "saving" ? "Adding…" : "Add calendar"}</Text>
          </Pressable>
        )}
      </View>
      {calendarState !== "done" && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {REMINDER_OPTIONS.map((opt) => (
            <Pressable accessibilityRole="button" key={opt.value} onPress={() => setCalendarReminder(opt.value)} style={chipStyle(calendarReminder === opt.value)}>
              <Text style={chipTextStyle(calendarReminder === opt.value)}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {calendarState === "error" && <Text style={{ fontSize: 12, color: theme.colors.critical }}>Couldn&apos;t add that to your calendar. Please try again.</Text>}

      {canCheckIn && (
        <>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary, marginTop: 4 }}>CHECK-IN REMINDER</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Pressable accessibilityRole="button" onPress={() => saveCheckInReminder(null)} disabled={checkInSaving} style={chipStyle(checkInReminder === null)}>
              <Text style={chipTextStyle(checkInReminder === null)}>Off</Text>
            </Pressable>
            {REMINDER_OPTIONS.map((opt) => (
              <Pressable accessibilityRole="button" key={opt.value} onPress={() => saveCheckInReminder(opt.value)} disabled={checkInSaving} style={chipStyle(checkInReminder === opt.value)}>
                <Text style={chipTextStyle(checkInReminder === opt.value)}>{opt.label}</Text>
              </Pressable>
            ))}
          </View>
          {checkInError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{checkInError}</Text>}
        </>
      )}

      {evidence !== undefined && (
        <View style={{ marginTop: 4 }}>
          {evidenceError ? <Text style={{ fontSize: 12, color: theme.colors.critical }}>{evidenceError}</Text> : <EvidenceCard evidence={evidence} />}
        </View>
      )}
    </Card>
  );
}
