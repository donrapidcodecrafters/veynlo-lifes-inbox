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

interface Place {
  id: string;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

interface PlaceCandidate {
  address: string | null;
  lat: number | null;
  lng: number | null;
  source: "extracted_maps_link" | "extracted_address";
}

/**
 * Phase 3 §30 "Location & Context" (LOC-001 "Saved places", basic tier is Core — no location permission
 * required to use this page at all, matching this app's mobile equivalent at apps/mobile/app/places.tsx).
 * On-device geofence monitoring (LOC-002) only runs on mobile via `expo-location`'s OS-native
 * geofencing — a browser has no equivalent background-monitoring capability, so this page manages the
 * same places/geofences/reminders data (they're shared across platforms via the API), but the actual
 * arrival/departure trigger only fires from the mobile app.
 */
export default function PlacesPage() {
  const { data: places, error: placesError, isLoading, mutate } = useSWR<Place[]>("/v1/places", swrFetcher);
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [candidate, setCandidate] = useState<PlaceCandidate | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [address, setAddress] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExtract() {
    if (!pasteText.trim()) return;
    setExtracting(true);
    setError(null);
    try {
      const { candidate: found } = await api.post<{ candidate: PlaceCandidate | null }>("/v1/places/extract", { text: pasteText });
      setCandidate(found);
      if (found) {
        setAddress(found.address ?? "");
        setLat(found.lat != null ? String(found.lat) : "");
        setLng(found.lng != null ? String(found.lng) : "");
        if (!label.trim()) setLabel(found.source === "extracted_maps_link" ? "New place" : (found.address ?? "New place"));
      } else {
        setError("Couldn't find a map link or address in that text — enter the place manually below.");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't parse that text.");
    } finally {
      setExtracting(false);
    }
  }

  async function createPlace(e: FormEvent) {
    e.preventDefault();
    const trimmedLat = lat.trim();
    const trimmedLng = lng.trim();
    if (Boolean(trimmedLat) !== Boolean(trimmedLng)) {
      setError("Enter both a latitude and a longitude, or leave both blank.");
      return;
    }
    let parsedLat: number | null = null;
    let parsedLng: number | null = null;
    if (trimmedLat && trimmedLng) {
      parsedLat = Number(trimmedLat);
      parsedLng = Number(trimmedLng);
      if (Number.isNaN(parsedLat) || Number.isNaN(parsedLng) || Math.abs(parsedLat) > 90 || Math.abs(parsedLng) > 180) {
        setError("Enter a valid latitude (-90 to 90) and longitude (-180 to 180).");
        return;
      }
    }
    setCreating(true);
    setError(null);
    try {
      await api.post("/v1/places", { label, address: address.trim() || null, lat: parsedLat, lng: parsedLng });
      setLabel("");
      setPasteText("");
      setCandidate(null);
      setAddress("");
      setLat("");
      setLng("");
      setShowForm(false);
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save this place.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold text-primary">Saved places</h1>
        <p className="mt-1 text-sm text-tertiary">
          Home, work, family, or anywhere you want an arrival/departure reminder. Arrival/departure reminders only fire from the
          mobile app, which is where location permission is granted — this page manages the same data.
        </p>
      </div>

      {!showForm && <Button onClick={() => setShowForm(true)}>+ Add a place</Button>}

      {showForm && (
        <Card>
          <CardBody className="space-y-4">
            <div>
              <Label htmlFor="paste">Paste a shared map link or address (optional)</Label>
              <Input
                id="paste"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="https://maps.google.com/... or 1600 Amphitheatre Pkwy, Mountain View, CA 94043"
              />
              <div className="mt-2">
                <Button type="button" variant="secondary" onClick={handleExtract} loading={extracting}>
                  Parse text
                </Button>
              </div>
              {candidate && (
                <p className="mt-2 text-sm text-positive-subtle-text">
                  {candidate.source === "extracted_maps_link" ? "Found coordinates from a map link." : "Found an address (no coordinates yet)."}
                </p>
              )}
            </div>

            <form onSubmit={createPlace} className="space-y-4">
              <div>
                <Label htmlFor="label">Name</Label>
                <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Home, Mom's house, Costco" required maxLength={120} />
              </div>
              <div>
                <Label htmlFor="address">Address (optional)</Label>
                <Input id="address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city, state, zip" maxLength={500} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="lat">Latitude (optional)</Label>
                  <Input id="lat" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="37.7749" inputMode="decimal" />
                </div>
                <div>
                  <Label htmlFor="lng">Longitude (optional)</Label>
                  <Input id="lng" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-122.4194" inputMode="decimal" />
                </div>
              </div>
              <p className="text-xs text-tertiary">Coordinates are needed only if you want an arrival/departure reminder for this place.</p>
              <FieldError>{error ?? undefined}</FieldError>
              <div className="flex gap-3">
                <Button type="submit" loading={creating}>
                  Save place
                </Button>
                <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}

      {isLoading && <div className="h-20 animate-pulse rounded-xl bg-subtle" />}
      {!isLoading && placesError && !places && <FetchError what="your saved places" message={placesError instanceof ApiError ? placesError.message : undefined} onRetry={() => mutate()} />}
      {places && places.length === 0 && (
        <EmptyState title="No saved places yet" description="Add a home, family member's address, or store to set up an arrival reminder." />
      )}
      {places && places.length > 0 && (
        <div className="space-y-2">
          {places.map((place) => (
            <Link key={place.id} href={`/places/${place.id}`}>
              <Card className="transition-colors hover:bg-subtle">
                <CardBody className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-[0.9375rem] font-medium text-primary">{place.label}</p>
                    {place.address && <p className="truncate text-sm text-tertiary">{place.address}</p>}
                  </div>
                  <Badge tone={place.lat != null ? "positive" : "neutral"}>{place.lat != null ? "Has coordinates" : "No coordinates"}</Badge>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
