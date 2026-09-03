import { useCallback, useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, useLocalSearchParams } from "expo-router";
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

const RECORD_TYPE_LABELS: Record<IdentityRecordType, string> = {
  passport: "Passport",
  drivers_license: "Driver's license",
  vehicle_registration: "Vehicle registration",
  professional_license: "Professional/recreational license",
  property_obligation: "Property/government obligation",
};

interface IdentityRecordDetail {
  record: {
    id: string;
    recordType: IdentityRecordType;
    label: string;
    issuingAuthority: string | null;
    issuedDate: TemporalValueLike | null;
    expirationDate: TemporalValueLike | null;
    jurisdiction: string | null;
    reminderLeadDays: number;
    status: "active" | "expired" | "renewed";
  };
  renewalLink: { url: string; label: string; source: "user" | "seeded" } | null;
  linkedVehicle: { id: string; label: string } | null;
  linkedProperty: { id: string; label: string } | null;
  previousVersion: { id: string; label: string } | null;
}

/** "Reveal/copy protected field" — §28.9 step-up, mobile counterpart to the web detail page's identical
 * `reveal(withPassword)` shape (try with no password first — a no-op for an OAuth-only account, prompt only
 * if the server asks) — same pattern health-appointment/[id].tsx's DocumentsPanel already uses. Copies to
 * the clipboard via expo-clipboard rather than a native "select all" gesture on a masked field. */
function RevealDocumentNumberPanel({ recordId }: { recordId: string }) {
  const { theme } = useAppTheme();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [copied, setCopied] = useState(false);

  async function reveal(withPassword?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ documentNumber: string | null }>(`/v1/identity-records/${recordId}/reveal-document-number`, { password: withPassword });
      setRevealed(result.documentNumber ?? "");
      setPasswordPromptOpen(false);
      setPassword("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setPasswordPromptOpen(true);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't reveal that field.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!revealed) return;
    await Clipboard.setStringAsync(revealed);
    setCopied(true);
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Document / ID number</Text>
      {revealed === null && !passwordPromptOpen && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, flex: 1 }}>Hidden until you confirm your password</Text>
          <Button variant="secondary" onPress={() => reveal()} loading={busy}>
            Reveal
          </Button>
        </View>
      )}
      {passwordPromptOpen && (
        <View style={{ gap: 8 }}>
          <TextField label="Confirm your password to reveal this" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} autoFocus />
          <Button onPress={() => reveal(password)} loading={busy}>
            Unlock
          </Button>
        </View>
      )}
      {revealed !== null && (
        <View style={{ gap: 8 }}>
          <Text selectable style={{ fontSize: 15, fontFamily: "monospace", color: theme.colors.textPrimary }}>
            {revealed || "(none on file)"}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {!!revealed && (
              <Button variant="secondary" onPress={copy}>
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
            <Button variant="ghost" onPress={() => setRevealed(null)}>
              Hide
            </Button>
          </View>
        </View>
      )}
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

function RenewPanel({ record, onRenewed }: { record: IdentityRecordDetail["record"]; onRenewed: (newId: string) => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [expirationIso, setExpirationIso] = useState("");
  const [documentNumber, setDocumentNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (record.status === "renewed") return null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ id: string }>(`/v1/identity-records/${record.id}/renew`, {
        expirationIso: expirationIso || undefined,
        documentNumber: documentNumber || undefined,
      });
      onRenewed(result.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't renew this record.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Mark renewed</Text>
      <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Creates a new record for the renewed document and marks this one as replaced — nothing is deleted.</Text>
      {!open && (
        <Button variant="secondary" onPress={() => setOpen(true)}>
          Renew
        </Button>
      )}
      {open && (
        <View style={{ gap: 8 }}>
          <TextField label="New expiration date (YYYY-MM-DD)" value={expirationIso} onChangeText={setExpirationIso} autoCapitalize="none" />
          <TextField label="New document/ID number (optional)" value={documentNumber} onChangeText={setDocumentNumber} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={submit} loading={busy}>
                Confirm renewal
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setOpen(false)}>
                Cancel
              </Button>
            </View>
          </View>
          {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
        </View>
      )}
    </Card>
  );
}

function ReminderLeadTimePanel({ record, onSaved }: { record: IdentityRecordDetail["record"]; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(String(record.reminderLeadDays));
  const [busy, setBusy] = useState(false);

  async function save() {
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    setBusy(true);
    try {
      await api.put(`/v1/identity-records/${record.id}`, { reminderLeadDays: parsed });
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Reminder lead time</Text>
      {!editing ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, flex: 1 }}>You&apos;ll be reminded {record.reminderLeadDays} days before this expires.</Text>
          <Button variant="secondary" onPress={() => setEditing(true)}>
            Edit
          </Button>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <TextField label="Days before expiration" value={days} onChangeText={setDays} keyboardType="number-pad" />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={save} loading={busy}>
                Save
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setEditing(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

/**
 * Mobile counterpart to apps/web/src/app/(app)/life/identity/[id]/page.tsx — see that file's own doc
 * comment. "Identity & Legal Continuity" (ID-001..005): reveal/copy the encrypted document number (§28.9
 * step-up), renewal/versioning, and per-record reminder lead time.
 */
export default function IdentityRecordDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<IdentityRecordDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<IdentityRecordDetail | null>(`/v1/identity-records/${id}`)
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
          what="this record"
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
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This record doesn't exist or you don't have access to it." /></Screen>;

  const { record, renewalLink, linkedVehicle, linkedProperty, previousVersion } = data;
  const issued = record.issuedDate ? formatTemporal(record.issuedDate) : null;
  const expires = record.expirationDate ? formatTemporal(record.expirationDate) : null;

  return (
    <Screen>
      <ScreenHeader title={record.label} subtitle={RECORD_TYPE_LABELS[record.recordType]} />

      <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
        Private by default — never visible to a household member just because you&apos;re in the same household.
      </Text>

      <View style={{ flexDirection: "row" }}>
        <Badge tone={record.status === "expired" ? "critical" : record.status === "renewed" ? "neutral" : "positive"}>
          {record.status === "expired" ? "Expired" : record.status === "renewed" ? "Renewed" : "Active"}
        </Badge>
      </View>

      {previousVersion && (
        <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Renewed from {previousVersion.label}.</Text>
      )}

      <Card style={{ gap: 6 }}>
        {record.issuingAuthority && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Issuing authority: {record.issuingAuthority}</Text>}
        {issued && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Issued: {issued}</Text>}
        {expires && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Expires: {expires}</Text>}
        {record.jurisdiction && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Jurisdiction: {record.jurisdiction}</Text>}
        {linkedVehicle && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Vehicle: {linkedVehicle.label}</Text>}
        {linkedProperty && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>Property: {linkedProperty.label}</Text>}
      </Card>

      <RevealDocumentNumberPanel recordId={record.id} />
      <ReminderLeadTimePanel record={record} onSaved={load} />

      {renewalLink && (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Official renewal link</Text>
          <Button variant="secondary" onPress={() => Linking.openURL(renewalLink.url)}>
            {renewalLink.label}
          </Button>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            {renewalLink.source === "user" ? "Your saved link" : "Curated official source — verify before relying on it"}
          </Text>
        </Card>
      )}

      <RenewPanel record={record} onRenewed={(newId) => router.replace(`/identity-record/${newId}`)} />
    </Screen>
  );
}
