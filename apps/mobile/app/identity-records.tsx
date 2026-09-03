import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { ScreenHeader } from "@/components/screen-header";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

type IdentityRecordType = "passport" | "drivers_license" | "vehicle_registration" | "professional_license" | "property_obligation";

interface IdentityRecordRow {
  id: string;
  recordType: IdentityRecordType;
  label: string;
  expirationDate: TemporalValueLike | null;
  status: "active" | "expired" | "renewed";
}

const RECORD_TYPE_LABELS: Record<IdentityRecordType, string> = {
  passport: "Passport",
  drivers_license: "Driver's license",
  vehicle_registration: "Vehicle registration",
  professional_license: "Professional/recreational license",
  property_obligation: "Property/government obligation",
};

const RECORD_TYPE_OPTIONS: Array<{ value: IdentityRecordType; label: string }> = [
  { value: "passport", label: "Passport" },
  { value: "drivers_license", label: "Driver's license / state ID" },
  { value: "vehicle_registration", label: "Vehicle registration" },
  { value: "professional_license", label: "Professional/recreational license" },
  { value: "property_obligation", label: "Property/government obligation" },
];

/** "Identity & Legal Continuity" (ID-001..005) manual-add — mobile counterpart to
 * apps/web/src/app/(app)/life/identity/page.tsx's AddIdentityRecordForm. A recordType picker plus the same
 * field set (`documentNumber` submitted once here, then never round-trips back to the client except through
 * the dedicated, step-up-gated reveal action on the detail screen). */
function AddIdentityRecordForm({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [recordType, setRecordType] = useState<IdentityRecordType>("passport");
  const [label, setLabel] = useState("");
  const [issuingAuthority, setIssuingAuthority] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button variant="secondary" onPress={() => setOpen(true)}>
        + Add an identity record
      </Button>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/identity-records", {
        recordType,
        label,
        issuingAuthority: issuingAuthority || undefined,
        documentNumber: documentNumber || undefined,
        expirationIso: expirationDate || undefined,
        jurisdiction: jurisdiction || undefined,
      });
      setLabel("");
      setIssuingAuthority("");
      setDocumentNumber("");
      setExpirationDate("");
      setJurisdiction("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that record.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary }}>Type</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {RECORD_TYPE_OPTIONS.map((opt) => (
          <Pressable accessibilityRole="button"
            key={opt.value}
            onPress={() => setRecordType(opt.value)}
            style={{
              paddingVertical: 6,
              paddingHorizontal: 12,
              borderRadius: 999,
              backgroundColor: recordType === opt.value ? theme.colors.brandDefault : theme.colors.bgSubtle,
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: recordType === opt.value ? theme.colors.textOnBrand : theme.colors.textPrimary }}>{opt.label}</Text>
          </Pressable>
        ))}
      </View>
      <TextField label="Name (e.g. US Passport)" value={label} onChangeText={setLabel} />
      <TextField label="Issuing authority (optional)" value={issuingAuthority} onChangeText={setIssuingAuthority} />
      <TextField label="Document/ID number (optional — encrypted, reveal requires your password later)" value={documentNumber} onChangeText={setDocumentNumber} />
      <TextField label="Expires (YYYY-MM-DD, optional)" value={expirationDate} onChangeText={setExpirationDate} autoCapitalize="none" />
      <TextField label="Jurisdiction (e.g. US, US-CA, optional)" value={jurisdiction} onChangeText={(t) => setJurisdiction(t.toUpperCase())} autoCapitalize="characters" />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!label.trim()}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

/**
 * "Identity & Legal Continuity" (ID-001..005) — private-by-default record list (see
 * IdentityRecordsService's own doc comment), mobile counterpart to
 * apps/web/src/app/(app)/life/identity/page.tsx. Tapping a row opens identity-record/[id].tsx for the
 * step-up-gated reveal/renew/reminder/jurisdiction-link actions.
 */
export default function IdentityRecordsScreen() {
  const { theme } = useAppTheme();
  const [records, setRecords] = useState<IdentityRecordRow[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<IdentityRecordRow[]>("/v1/identity-records")
      .then(setRecords)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your identity records."))
      .finally(() => setRetrying(false));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const active = records?.filter((r) => r.status !== "renewed");

  return (
    <Screen>
      <ScreenHeader
        title="Identity & legal documents"
        subtitle="Passports, licenses, registrations, and permits — private by default, with their own expiration reminders."
      />
      {error && (
        <FetchError
          message={error}
          what="your identity records"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      )}
      {records === undefined && !error && <View style={{ height: 80, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
      {active && active.length === 0 && (
        <EmptyState title="No identity records yet" description="Add your first passport, license, registration, or permit below." />
      )}
      {active && active.length > 0 && (
        <View style={{ gap: 8 }}>
          {active.map((r) => {
            const expires = r.expirationDate ? formatTemporal(r.expirationDate) : null;
            return (
              <Pressable accessibilityRole="button" key={r.id} onPress={() => router.push(`/identity-record/${r.id}`)}>
                <Card style={{ gap: 4 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{r.label}</Text>
                      <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{RECORD_TYPE_LABELS[r.recordType]}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      {expires && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Expires {expires}</Text>}
                      <Badge tone={r.status === "expired" ? "critical" : "neutral"}>{r.status === "expired" ? "Expired" : "Active"}</Badge>
                    </View>
                  </View>
                </Card>
              </Pressable>
            );
          })}
        </View>
      )}
      <AddIdentityRecordForm onAdded={load} />
    </Screen>
  );
}
