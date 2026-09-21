"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

/**
 * Choosing which devices Veynlo reads from a Home Assistant.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this is its own screen
 * ---------------------------------------------------------------------------------------------------
 * A real Home Assistant has hundreds of entities. Even after the connector drops the diagnostic clutter,
 * a normal house leaves thirty or forty things to choose between — which is a list, not a card. Putting it
 * inline on Connections would have added forty rows to a page that already carries email, calendars,
 * files, tasks, banking, school feeds and forwarding.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why the token's reach is not the authorization
 * ---------------------------------------------------------------------------------------------------
 * A Long-Lived Access Token can read every entity in the house, including the ones that say whether
 * anyone is home. This screen is where the user decides what that token is actually used for, and nothing
 * is read until something here is on — the same shape as the Android notification picker, where the
 * all-or-nothing system grant is not the permission and the per-app list is.
 */
interface Device {
  providerDeviceId: string;
  label: string;
  deviceType: string;
  room: string | null;
  isSelected: boolean;
}

interface SmartHomeConnection {
  id: string;
  provider: string;
  status: string;
  healthDetail: string | null;
  baseUrl: string | null;
  lastSuccessfulSyncAt: string | null;
  selectedDevices: { id: string; label: string; deviceType: string }[];
}

/** Plain words for the entity domains this connector offers. "binary_sensor" means nothing to a person. */
const DEVICE_TYPE_LABEL: Record<string, string> = {
  lock: "Lock",
  thermostat: "Thermostat",
  camera: "Camera",
  sensor: "Sensor",
  hub: "Hub",
  other: "Other",
};

export default function SmartHomeDevicesPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<Device[]>(`/v1/smart-home/connections/${id}/devices`, swrFetcher);
  const { data: connections } = useSWR<SmartHomeConnection[]>("/v1/smart-home/connections", swrFetcher);
  const connection = connections?.find((c) => c.id === id);

  const [search, setSearch] = useState("");
  /** The pending selection, seeded from the server and edited locally until Save. */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data && selected === null) {
      setSelected(new Set(data.filter((d) => d.isSelected).map((d) => d.providerDeviceId)));
    }
  }, [data, selected]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return data ?? [];
    return (data ?? []).filter((d) => d.label.toLowerCase().includes(needle) || d.providerDeviceId.toLowerCase().includes(needle));
  }, [data, search]);

  const serverSelection = useMemo(
    () => new Set((data ?? []).filter((d) => d.isSelected).map((d) => d.providerDeviceId)),
    [data],
  );

  // Save is only offered when there is genuinely something to save. A button that is always enabled and
  // usually a no-op teaches people to press it without reading.
  const dirty =
    selected !== null &&
    (selected.size !== serverSelection.size || [...selected].some((entityId) => !serverSelection.has(entityId)));

  function toggle(entityId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current ?? []);
      if (on) next.add(entityId);
      else next.delete(entityId);
      return next;
    });
    setSaved(false);
  }

  async function save() {
    if (!selected) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.put(`/v1/smart-home/connections/${id}/devices`, { providerDeviceIds: [...selected] });
      setSaved(true);
      await mutate();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't save your choices. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const chosen = selected?.size ?? 0;

  return (
    <div className="space-y-4">
      {/* Every screen needs an obvious way back to its parent — this one is reachable only from
          Connections, so that is where it returns. */}
      <Link href="/connections" className="text-sm text-tertiary hover:text-primary">
        ← Connections
      </Link>

      <div>
        <h1 className="text-xl font-semibold text-primary">Choose devices</h1>
        <p className="mt-1 text-sm text-tertiary">
          Veynlo reads only the devices you turn on here. It looks for a leak, smoke or carbon monoxide, a flat battery, a fault, and
          anything that&apos;s stopped responding — not history, not who&apos;s home.
        </p>
        {connection?.baseUrl && <p className="mt-1 truncate text-sm text-tertiary">{connection.baseUrl}</p>}
      </div>

      {isLoading && <div className="h-40 animate-pulse rounded-xl bg-subtle" />}

      {!isLoading && error && (
        <FetchError
          what="the devices on this Home Assistant"
          message={error instanceof ApiError ? error.message : undefined}
          onRetry={() => mutate()}
        />
      )}

      {!isLoading && !error && data && data.length === 0 && (
        <EmptyState
          title="Nothing to choose from yet"
          description="This Home Assistant didn't report any locks, thermostats, cameras or sensors Veynlo can use. If you've just set it up, add a device there and come back."
        />
      )}

      {!isLoading && !error && data && data.length > 0 && (
        <>
          <Card>
            <CardBody className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-tertiary">
                  {chosen === 0 ? "Nothing chosen — nothing is being read." : `${chosen} of ${data.length} chosen.`}
                </p>
                {saved && !dirty && <p className="text-sm text-positive-subtle-text">Saved.</p>}
              </div>

              <div>
                {/* The placeholder is not a label: it vanishes the moment anyone types, and a placeholder alone
                    leaves the field anonymous to a screen reader. An sr-only <label for> names it for good.
                    No aria-label alongside it — that would win over the label and give two sources of truth
                    for one name. */}
                <label htmlFor="device-search" className="sr-only">
                  Search devices
                </label>
                <Input id="device-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search devices" />
              </div>

              {saveError && <p className="text-sm text-critical-subtle-text">{saveError}</p>}

              <div className="flex flex-wrap gap-2">
                <Button onClick={save} disabled={!dirty || saving}>
                  {saving ? "Saving…" : "Save choices"}
                </Button>
                {dirty && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSelected(new Set(serverSelection));
                      setSaved(false);
                    }}
                    disabled={saving}
                  >
                    Undo changes
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>

          {filtered.length === 0 && (
            <EmptyState title="No devices match that" description="Try a shorter search, or clear it to see everything again." />
          )}

          <div className="space-y-2">
            {filtered.map((device) => (
              <Card key={device.providerDeviceId}>
                <CardBody>
                  <Switch
                    id={`device-${device.providerDeviceId.replace(/[^a-zA-Z0-9]/g, "-")}`}
                    checked={selected?.has(device.providerDeviceId) ?? false}
                    onCheckedChange={(on) => toggle(device.providerDeviceId, on)}
                    label={device.label}
                    description={`${DEVICE_TYPE_LABEL[device.deviceType] ?? device.deviceType}${device.room ? ` · ${device.room}` : ""}`}
                  />
                </CardBody>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
