import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
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

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
    >
      <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textOnBrand : theme.colors.textSecondary }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Mobile counterpart to the web fix at apps/web/src/app/(app)/life/warranties/[id]/page.tsx — see that
 * file's LinkAssetPanel doc comment for why this is property/vehicle only (no homeAssetId picker: there's
 * no standalone list-all-home-assets endpoint to source options from).
 */
function LinkAssetPanel({ warranty, onLinked }: { warranty: WarrantyDetail["warranty"]; onLinked: () => void }) {
  const { theme } = useAppTheme();
  const [properties, setProperties] = useState<PickableProfile[]>([]);
  const [vehicles, setVehicles] = useState<PickableProfile[]>([]);
  const [kind, setKind] = useState<"property" | "vehicle">(warranty.vehicleProfileId ? "vehicle" : "property");
  const [selectedId, setSelectedId] = useState(warranty.propertyProfileId ?? warranty.vehicleProfileId ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<PickableProfile[]>("/v1/properties").then(setProperties).catch(() => {});
    api.get<PickableProfile[]>("/v1/vehicles").then(setVehicles).catch(() => {});
  }, []);

  const options = kind === "property" ? properties : vehicles;
  const currentlyLinkedLabel =
    warranty.propertyProfileId != null
      ? (properties.find((p) => p.id === warranty.propertyProfileId)?.label ?? "a property")
      : warranty.vehicleProfileId != null
        ? (vehicles.find((v) => v.id === warranty.vehicleProfileId)?.label ?? "a vehicle")
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
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Linked property or vehicle</Text>
      {currentlyLinkedLabel ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, flexShrink: 1 }}>
            Currently linked to <Text style={{ color: theme.colors.textPrimary }}>{currentlyLinkedLabel}</Text>.
          </Text>
          <Pressable accessibilityRole="button" onPress={clearLink} disabled={submitting}>
            <Text style={{ fontSize: 13, color: theme.colors.critical }}>{submitting ? "Clearing…" : "Clear"}</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Not linked to a property or vehicle yet.</Text>
      )}
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Pill label="Property" active={kind === "property"} onPress={() => { setKind("property"); setSelectedId(""); }} />
        <Pill label="Vehicle" active={kind === "vehicle"} onPress={() => { setKind("vehicle"); setSelectedId(""); }} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {options.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{kind === "property" ? "No properties yet." : "No vehicles yet."}</Text>}
        {options.map((o) => (
          <Pill key={o.id} label={o.label} active={selectedId === o.id} onPress={() => setSelectedId(o.id)} />
        ))}
      </View>
      <Button variant="secondary" disabled={submitting || !selectedId} loading={submitting} onPress={saveLink}>
        Save link
      </Button>
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

export default function WarrantyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<WarrantyDetail | null | undefined>(undefined);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Found live: no reusable load function existed here — a transient 500/network error left the user
  // permanently stuck on "Something went wrong" with no in-place recovery. Mirrors bill/[id].tsx's
  // identical fix: wired to FetchError's own Retry button instead.
  const load = useCallback(() => {
    setError(null);
    api
      .get<WarrantyDetail | null>(`/v1/warranties/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this warranty"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This warranty doesn't exist or you don't have access to it." /></Screen>;

  const { warranty, evidence } = data;
  const expires = formatTemporal(warranty.expirationDate);
  const days = daysUntil(warranty.expirationDate);

  return (
    <Screen>
      <ScreenHeader title={warranty.productLabel} subtitle={expires ? `Expires ${expires}` : undefined} />
      {/* Mirrors the web fix's banner — set automatically by CommerceService.resolveReturn when the return
          case for this exact purchase line resolves. */}
      {warranty.voidedAt && (
        <Card style={{ backgroundColor: theme.colors.warningSubtleBg, borderColor: theme.colors.warning }}>
          <Text style={{ fontSize: 13, color: theme.colors.warning }}>
            This product was returned on {new Date(warranty.voidedAt).toLocaleDateString()} — this warranty may no longer apply.
          </Text>
        </Card>
      )}
      <Card style={{ gap: 6 }}>
        {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
        {warranty.warrantyLengthMonths != null && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{warranty.warrantyLengthMonths} months</Text>
        )}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Registered: {warranty.registrationConfirmed == null ? "Unknown" : warranty.registrationConfirmed ? "Yes" : "No"}
        </Text>
        {/* Property/vehicle detail screens link forward into their linked warranties, but this screen had
            no way back — mirrors the web fix at life/warranties/[id]/page.tsx (§644 "detail pages include
            History" implies this should be navigable in both directions). */}
        {warranty.propertyProfileId && (
          <Pressable accessibilityRole="button" onPress={() => router.push(`/property/${warranty.propertyProfileId}`)}>
            <Text style={{ fontSize: 13, color: theme.colors.brandDefault }}>View property →</Text>
          </Pressable>
        )}
        {warranty.vehicleProfileId && (
          <Pressable accessibilityRole="button" onPress={() => router.push(`/vehicle/${warranty.vehicleProfileId}`)}>
            <Text style={{ fontSize: 13, color: theme.colors.brandDefault }}>View vehicle →</Text>
          </Pressable>
        )}
      </Card>
      <LinkAssetPanel warranty={warranty} onLinked={load} />
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
