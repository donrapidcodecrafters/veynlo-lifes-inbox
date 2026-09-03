import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { FetchError } from "@/components/fetch-error";
import { HouseholdPicker } from "@/components/household-picker";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";

interface PetDetail {
  pet: {
    id: string;
    label: string;
    species: string | null;
    breed: string | null;
    microchipNumber: string | null;
    vetProviderName: string | null;
    insuranceProviderName: string | null;
    insurancePolicyNumber: string | null;
    lifecycleStatus: "active" | "deceased" | "transferred";
    householdId: string | null;
  };
  vaccinations: Array<{ id: string; label: string; expirationDate: TemporalValueLike | null; source: "user_confirmed" | "evidence_sourced"; evidence: Evidence | null }>;
  maintenance: Array<{ id: string; description: string; serviceDate: TemporalValueLike; costMinorUnits: number | null; costCurrency: string | null }>;
  refillReminders: Array<{ id: string; medicationName: string; nextRefillDate: TemporalValueLike; pharmacy: string | null; pickedUpAt: string | null }>;
  bills: Array<{ id: string; billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null; dueDate: TemporalValueLike }>;
}

export default function PetDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<PetDetail | null | undefined>(undefined);
  const [addingRecord, setAddingRecord] = useState(false);
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [addingVaccination, setAddingVaccination] = useState(false);
  const [vaccinationLabel, setVaccinationLabel] = useState("");
  const [vaccinationExpiration, setVaccinationExpiration] = useState("");
  const [addingReminder, setAddingReminder] = useState(false);
  const [medicationName, setMedicationName] = useState("");
  const [nextRefillDate, setNextRefillDate] = useState("");
  const [pharmacy, setPharmacy] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Inline confirm state, not RN's Alert.alert — matches this app's established destructive-confirm
  // convention (see list/[id].tsx's own doc comment on `confirmingDeleteList` for why: react-native-web's
  // Alert.alert is a permanent no-op, confirmed live). Mirrors person/[id].tsx's identical
  // `confirmingDelete` for its own "Remove person" action.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Same "map a 404 to setData(null), everything else to an inline error" fix vehicle/[id].tsx's own doc
  // comment explains — a bare .then with no .catch on a mount-time fetch becomes an unhandled promise
  // rejection that crashes the whole app on React Native Web (confirmed live on the identical vehicle
  // screen this mirrors).
  const load = useCallback(() => {
    setError(null);
    api
      .get<PetDetail | null>(`/v1/pets/${id}`)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setData(null);
        } else {
          setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again.");
        }
      })
      .finally(() => setRetrying(false));
  }, [id]);

  useFocusEffect(load);

  async function addRecord() {
    if (!description.trim()) return;
    const trimmedCost = cost.trim();
    const parsedCost = trimmedCost ? Number(trimmedCost) : null;
    if (trimmedCost && (Number.isNaN(parsedCost) || parsedCost! < 0)) {
      setActionError("Enter a valid, non-negative cost (e.g. 42.50), or leave it blank.");
      return;
    }
    setSubmitting(true);
    setActionError(null);
    try {
      await api.post("/v1/maintenance-records", {
        description,
        petProfileId: id,
        costMinorUnits: parsedCost != null ? Math.round(parsedCost * 100) : undefined,
        costCurrency: parsedCost != null ? "USD" : undefined,
      });
      setDescription("");
      setCost("");
      setAddingRecord(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add this record. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function addVaccination() {
    if (!vaccinationLabel.trim()) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.post(`/v1/pets/${id}/vaccinations`, { label: vaccinationLabel, expirationDateIso: vaccinationExpiration || undefined });
      setVaccinationLabel("");
      setVaccinationExpiration("");
      setAddingVaccination(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add this record. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function addReminder() {
    if (!medicationName.trim() || !nextRefillDate) return;
    setSubmitting(true);
    setActionError(null);
    try {
      await api.post(`/v1/pets/${id}/refill-reminders`, { medicationName, nextRefillDateIso: nextRefillDate, pharmacy: pharmacy || undefined });
      setMedicationName("");
      setNextRefillDate("");
      setPharmacy("");
      setAddingReminder(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add this reminder. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function markPickedUp(reminderId: string) {
    setActionError(null);
    try {
      await api.post(`/v1/pet-refill-reminders/${reminderId}/mark-picked-up`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this reminder. Please try again.");
    }
  }

  async function remove() {
    setDeleting(true);
    setActionError(null);
    try {
      await api.delete(`/v1/pets/${id}`);
      router.back();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this pet. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  // Household-assignment gap close — mirrors person/[id].tsx's identical immediate-save private/household
  // toggle. `PATCH /v1/pets/{id}` already existed but didn't accept `householdId` from any UI; `null`
  // explicitly means "make private again".
  async function saveHousehold(householdId: string | null) {
    await api.patch(`/v1/pets/${id}`, { householdId });
    load();
  }

  // Guarded on `data === undefined` (not just `error` alone) so a refetch that fails after this screen
  // already loaded successfully once — `load` reruns on every `useFocusEffect`, e.g. navigating back into
  // this screen — doesn't blow away the already-loaded pet view. Mirrors trip/[id].tsx's identical guard.
  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this pet"
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
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This pet doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const { pet, vaccinations, maintenance, refillReminders, bills } = data;
  const subtitle = [pet.species, pet.breed].filter(Boolean).join(" · ");

  return (
    <Screen>
      <ScreenHeader title={pet.label} subtitle={subtitle || undefined} />

      {/* This screen's `actionError` is shared across add vaccination, add refill reminder, mark picked
          up, add maintenance record, and remove pet — but used to render only once, right before the
          "Remove pet" button at the very bottom of a long scrollable page (mirrors vehicle/[id].tsx's and
          property/[id].tsx's identical bug and fix: an error from the vaccination or refill-reminder form,
          both near the TOP of the page, was invisible without scrolling past every card below them).
          Shown immediately below the header instead, matching automations.tsx's top-of-screen placement
          for its own multi-action error. The maintenance-record form below keeps its own inline copy too,
          guarded so it doesn't also duplicate here. */}
      {actionError && !addingRecord && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button variant="ghost" onPress={() => setSharing((s) => !s)}>
          Share
        </Button>
      </View>
      {sharing && (
        <Card>
          <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/pets" resourceLabel="pet" />
        </Card>
      )}

      <HouseholdPicker mode="edit" value={pet.householdId} onSave={saveHousehold} />

      {(pet.vetProviderName || pet.insuranceProviderName || pet.microchipNumber) && (
        <Card style={{ gap: 4 }}>
          {pet.vetProviderName && <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>Vet: {pet.vetProviderName}</Text>}
          {pet.insuranceProviderName && (
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
              Insurance: {pet.insuranceProviderName}
              {pet.insurancePolicyNumber ? ` — ${pet.insurancePolicyNumber}` : ""}
            </Text>
          )}
          {pet.microchipNumber && <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>Microchip: {pet.microchipNumber}</Text>}
        </Card>
      )}

      <Card style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Vaccinations & licenses</Text>
        {vaccinations.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None recorded yet.</Text>}
        {vaccinations.map((v) => (
          <VaccinationRow key={v.id} vaccination={v} />
        ))}
        {!addingVaccination ? (
          <Pressable accessibilityRole="button" onPress={() => setAddingVaccination(true)}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a vaccination/license</Text>
          </Pressable>
        ) : (
          <View style={{ gap: 8 }}>
            <TextField label="Label" placeholder="e.g. Rabies" value={vaccinationLabel} onChangeText={setVaccinationLabel} />
            <TextField label="Expiration date (optional, YYYY-MM-DD)" value={vaccinationExpiration} onChangeText={setVaccinationExpiration} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addVaccination} loading={submitting} disabled={!vaccinationLabel.trim()}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setAddingVaccination(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      <Card style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Medication / refill reminders</Text>
        {refillReminders.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None recorded yet.</Text>}
        {refillReminders.map((r) => {
          const when = formatTemporal(r.nextRefillDate);
          return (
            <View key={r.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
              <View>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                  {r.medicationName}
                  {r.pharmacy ? ` — ${r.pharmacy}` : ""}
                </Text>
                {when && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Next refill {when}</Text>}
              </View>
              {r.pickedUpAt ? (
                <Badge tone="positive">Picked up</Badge>
              ) : (
                <Button variant="secondary" onPress={() => markPickedUp(r.id)}>
                  Mark picked up
                </Button>
              )}
            </View>
          );
        })}
        {!addingReminder ? (
          <Pressable accessibilityRole="button" onPress={() => setAddingReminder(true)}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a refill reminder</Text>
          </Pressable>
        ) : (
          <View style={{ gap: 8 }}>
            <TextField label="Medication name" value={medicationName} onChangeText={setMedicationName} />
            <TextField label="Next refill date (YYYY-MM-DD)" value={nextRefillDate} onChangeText={setNextRefillDate} />
            <TextField label="Pharmacy (optional)" value={pharmacy} onChangeText={setPharmacy} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addReminder} loading={submitting} disabled={!medicationName.trim() || !nextRefillDate}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setAddingReminder(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      {bills.length > 0 && (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Insurance & vet bills</Text>
          {bills.map((b) => {
            const due = formatTemporal(b.dueDate);
            const amount = formatMoneyMinorUnits(b.amountDueMinorUnits, b.amountDueCurrency);
            return (
              <View key={b.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
                <View>
                  <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{b.billerLabel}</Text>
                  {due && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Due {due}</Text>}
                </View>
                {amount && <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{amount}</Text>}
              </View>
            );
          })}
        </Card>
      )}

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Vet visits & service history</Text>
          {!addingRecord && (
            <Pressable accessibilityRole="button" onPress={() => setAddingRecord(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a record</Text>
            </Pressable>
          )}
        </View>
        {maintenance.length === 0 && !addingRecord && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No visit history logged yet.</Text>}
        {maintenance.map((m) => {
          const date = formatTemporal(m.serviceDate);
          const amount = formatMoneyMinorUnits(m.costMinorUnits, m.costCurrency);
          return (
            <View key={m.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
              <View>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{m.description}</Text>
                {date && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>{date}</Text>}
              </View>
              {amount && <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{amount}</Text>}
            </View>
          );
        })}
        {addingRecord && (
          <View style={{ gap: 8 }}>
            <TextField label="Description" placeholder="e.g. Annual checkup" value={description} onChangeText={setDescription} />
            <TextField label="Cost (USD, optional)" value={cost} onChangeText={setCost} keyboardType="decimal-pad" />
            {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addRecord} loading={submitting} disabled={!description.trim()}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setAddingRecord(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      {!confirmingDelete ? (
        <Button variant="secondary" onPress={() => setConfirmingDelete(true)}>
          Remove pet
        </Button>
      ) : (
        <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
            This removes {pet.label} and their vaccinations, reminders, and visit history. It can&apos;t be undone.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="critical" onPress={remove} loading={deleting}>
                Confirm remove
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Screen>
  );
}

/** AI-001 "why am I seeing this?" — mirrors the web pet detail page's identical VaccinationRow: a
 * discovered (evidence_sourced) vaccination can show its source email; a manually-entered
 * (user_confirmed) one has no evidence to show and gets no disclosure at all. */
function VaccinationRow({ vaccination }: { vaccination: { id: string; label: string; expirationDate: TemporalValueLike | null; source: "user_confirmed" | "evidence_sourced"; evidence: Evidence | null } }) {
  const { theme } = useAppTheme();
  const [showEvidence, setShowEvidence] = useState(false);
  const days = vaccination.expirationDate ? daysUntil(vaccination.expirationDate) : null;
  return (
    <View style={{ paddingVertical: 4, gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{vaccination.label}</Text>
          {vaccination.evidence && (
            <Pressable accessibilityRole="button" onPress={() => setShowEvidence((v) => !v)}>
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault }}>{showEvidence ? "Hide why" : "Why?"}</Text>
            </Pressable>
          )}
        </View>
        {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
      </View>
      {showEvidence && <EvidenceCard evidence={vaccination.evidence} />}
    </View>
  );
}
