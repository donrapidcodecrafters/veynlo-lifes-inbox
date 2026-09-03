"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

interface Place {
  id: string;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
}

interface Geofence {
  id: string;
  placeId: string;
  radiusMeters: number;
  triggerKind: string;
  isActive: boolean;
}

interface ContextRule {
  id: string;
  geofenceId: string;
  actionKind: string;
  actionTitle: string;
  isActive: boolean;
}

const TRIGGER_OPTIONS = [
  { value: "arrival", label: "Arriving" },
  { value: "departure", label: "Leaving" },
  { value: "both", label: "Both" },
] as const;

/**
 * LOC-001/002/003. Managing geofences/reminders here is real data-layer editing — the actual on-device
 * arrival/departure trigger only fires from the mobile app's OS-native geofencing (this page has no
 * browser-side geofencing capability at all, and doesn't attempt to fake one).
 */
export default function PlaceDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const { data: places, error: placesError, mutate: mutatePlaces } = useSWR<Place[]>("/v1/places", swrFetcher);
  const { data: geofences, mutate: mutateGeofences } = useSWR<Geofence[]>("/v1/geofences", swrFetcher);
  const { data: rules, mutate: mutateRules } = useSWR<ContextRule[]>("/v1/context-rules", swrFetcher);

  const place = places?.find((p) => p.id === id);
  const placeGeofences = (geofences ?? []).filter((g) => g.placeId === id);

  const [radius, setRadius] = useState("150");
  const [trigger, setTrigger] = useState<(typeof TRIGGER_OPTIONS)[number]["value"]>("arrival");
  const [creatingGeofence, setCreatingGeofence] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<Record<string, string>>({});
  const [creatingRuleFor, setCreatingRuleFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function createGeofence() {
    const parsedRadius = Number(radius);
    if (!Number.isFinite(parsedRadius) || parsedRadius < 20 || parsedRadius > 50_000) {
      setError("Enter a radius between 20 and 50,000 meters.");
      return;
    }
    setCreatingGeofence(true);
    setError(null);
    try {
      await api.post("/v1/geofences", { placeId: id, radiusMeters: Math.round(parsedRadius), triggerKind: trigger });
      mutateGeofences();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this reminder zone.");
    } finally {
      setCreatingGeofence(false);
    }
  }

  async function toggleGeofence(geofence: Geofence) {
    try {
      await api.patch(`/v1/geofences/${geofence.id}`, { isActive: !geofence.isActive });
      mutateGeofences();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update this reminder zone.");
    }
  }

  async function deleteGeofence(geofenceId: string) {
    try {
      await api.delete(`/v1/geofences/${geofenceId}`);
      mutateGeofences();
      mutateRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove this reminder zone.");
    }
  }

  async function createRule(geofenceId: string) {
    const title = (ruleDraft[geofenceId] ?? "").trim();
    if (!title) return;
    setCreatingRuleFor(geofenceId);
    setError(null);
    try {
      await api.post("/v1/context-rules", { geofenceId, actionKind: "remind", actionTitle: title });
      setRuleDraft((prev) => ({ ...prev, [geofenceId]: "" }));
      mutateRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create this reminder.");
    } finally {
      setCreatingRuleFor(null);
    }
  }

  async function deleteRule(ruleId: string) {
    try {
      await api.delete(`/v1/context-rules/${ruleId}`);
      mutateRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove this reminder.");
    }
  }

  async function deletePlace() {
    setDeleting(true);
    try {
      await api.delete(`/v1/places/${id}`);
      router.push("/places");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove this place.");
      setDeleting(false);
    }
  }

  if (placesError && !places) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <FetchError what="this place" message={placesError instanceof ApiError ? placesError.message : undefined} onRetry={() => mutatePlaces()} />
      </div>
    );
  }

  if (places && !place) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <EmptyState title="Not found" description="This place doesn't exist or you don't have access to it." />
      </div>
    );
  }

  const hasCoordinates = place && place.lat != null && place.lng != null;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="break-words text-2xl font-semibold text-primary">{place?.label ?? "Place"}</h1>
        {place?.address && <p className="mt-1 break-words text-sm text-tertiary">{place.address}</p>}
      </div>

      <FieldError>{error ?? undefined}</FieldError>

      <Card>
        <CardBody className="space-y-3">
          <Badge tone={hasCoordinates ? "positive" : "neutral"}>{hasCoordinates ? "Has coordinates" : "No coordinates yet"}</Badge>
          {!hasCoordinates && (
            <p className="text-sm text-tertiary">Add a latitude/longitude to this place before setting up an arrival/departure reminder.</p>
          )}
          <Button variant="critical" onClick={deletePlace} loading={deleting}>
            Remove this place
          </Button>
        </CardBody>
      </Card>

      {hasCoordinates && (
        <Card>
          <CardBody className="space-y-4">
            <h2 className="text-[0.9375rem] font-medium text-primary">Add a reminder zone</h2>
            <div>
              <Label htmlFor="radius">Radius (meters)</Label>
              <Input id="radius" value={radius} onChange={(e) => setRadius(e.target.value)} inputMode="numeric" />
            </div>
            <div className="flex gap-2">
              {TRIGGER_OPTIONS.map((opt) => (
                <Button key={opt.value} type="button" variant={trigger === opt.value ? "primary" : "secondary"} onClick={() => setTrigger(opt.value)}>
                  {opt.label}
                </Button>
              ))}
            </div>
            <Button onClick={createGeofence} loading={creatingGeofence}>
              Create reminder zone
            </Button>
          </CardBody>
        </Card>
      )}

      {placeGeofences.map((geofence) => (
        <Card key={geofence.id}>
          <CardBody className="space-y-4">
            <Switch
              checked={geofence.isActive}
              onCheckedChange={() => toggleGeofence(geofence)}
              label={`${geofence.radiusMeters}m — ${TRIGGER_OPTIONS.find((o) => o.value === geofence.triggerKind)?.label ?? geofence.triggerKind}`}
              description={geofence.isActive ? "Active" : "Turned off"}
            />

            <div className="space-y-2">
              {(rules ?? [])
                .filter((r) => r.geofenceId === geofence.id)
                .map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 break-words text-sm text-primary">{rule.actionTitle}</span>
                    <Button variant="ghost" className="shrink-0" onClick={() => deleteRule(rule.id)}>
                      Remove
                    </Button>
                  </div>
                ))}
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor={`rule-${geofence.id}`}>Remind me to…</Label>
                <Input
                  id={`rule-${geofence.id}`}
                  value={ruleDraft[geofence.id] ?? ""}
                  onChange={(e) => setRuleDraft((prev) => ({ ...prev, [geofence.id]: e.target.value }))}
                  placeholder="Check the sprinkler"
                />
              </div>
              <Button onClick={() => createRule(geofence.id)} loading={creatingRuleFor === geofence.id}>
                Add
              </Button>
            </div>

            <Button variant="ghost" onClick={() => deleteGeofence(geofence.id)}>
              Delete this reminder zone
            </Button>
          </CardBody>
        </Card>
      ))}
    </div>
  );
}
