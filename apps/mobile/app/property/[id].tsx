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

interface RecallMatch {
  id: string;
  component: string | null;
  summary: string;
  status: "open" | "potential_match_verify_vin" | "closed_or_repaired";
}

interface MaintenanceRule {
  id: string;
  label: string;
  intervalDays: number | null;
  lastPerformedDate: TemporalValueLike | null;
  source: "user_added" | "seeded_generic_guidance";
  confidenceNote: string | null;
}

interface MaintenanceRuleTemplate {
  key: string;
  label: string;
  intervalDays?: number;
  confidenceNote: string;
}

interface HomeAsset {
  id: string;
  label: string;
  room: string | null;
  make: string | null;
  model: string | null;
  recalls: RecallMatch[];
  maintenanceRules: MaintenanceRule[];
}

interface PropertyDetail {
  property: { id: string; label: string; propertyType: string; address: string | null; moveInDate: TemporalValueLike; householdId: string | null };
  warranties: Array<{ id: string; productLabel: string; expirationDate: TemporalValueLike }>;
  maintenance: Array<{ id: string; description: string; serviceDate: TemporalValueLike; costMinorUnits: number | null; costCurrency: string | null }>;
  homeAssets: HomeAsset[];
}

// HOMEOS-008 — mirrors apps/web's identical vocabulary (life/properties/[id]/page.tsx and vehicles/[id]/page.tsx).
const RECALL_STATUS_LABEL: Record<RecallMatch["status"], string> = {
  open: "Confirmed — needs action",
  potential_match_verify_vin: "Potential match — verify",
  closed_or_repaired: "Repaired / closed",
};
const RECALL_STATUS_TONE: Record<RecallMatch["status"], "critical" | "warning" | "positive"> = {
  open: "critical",
  potential_match_verify_vin: "warning",
  closed_or_repaired: "positive",
};

export default function PropertyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<PropertyDetail | null | undefined>(undefined);
  const [addingRecord, setAddingRecord] = useState(false);
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Inline confirm state, not RN's Alert.alert — matches this app's established destructive-confirm
  // convention (see list/[id].tsx's own doc comment on `confirmingDeleteList` for why: react-native-web's
  // Alert.alert is a permanent no-op, confirmed live). Mirrors person/[id].tsx's identical
  // `confirmingDelete` for its own "Remove person" action.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [addingAsset, setAddingAsset] = useState(false);
  const [assetLabel, setAssetLabel] = useState("");
  const [assetRoom, setAssetRoom] = useState("");
  const [assetMake, setAssetMake] = useState("");
  const [checkingAssetId, setCheckingAssetId] = useState<string | null>(null);
  // HOMEOS-004 — per-asset maintenance rules. Templates are fetched lazily (per asset, on first "+ Add
  // rule" tap) rather than up front for every asset on screen — mirrors apps/web's properties/[id]/page.tsx.
  const [ruleTemplatesByAsset, setRuleTemplatesByAsset] = useState<Record<string, MaintenanceRuleTemplate[]>>({});
  const [addingRuleForAsset, setAddingRuleForAsset] = useState<string | null>(null);
  const [ruleLabel, setRuleLabel] = useState("");
  const [ruleIntervalDays, setRuleIntervalDays] = useState("");
  const [ruleSubmitting, setRuleSubmitting] = useState(false);
  const [ruleBusyId, setRuleBusyId] = useState<string | null>(null);
  // A bare `.then`/`await` with no `.catch` on a mount-time fetch (or on the add-record/remove actions
  // below) becomes an unhandled promise rejection on any failure, which React Native Web surfaces as a
  // full-screen "Uncaught Error" dev overlay blocking the entire app, not just this screen (confirmed
  // live — see entity/[id].tsx's identical fix and doc comment). Unlike the other 8 detail screens in this
  // app, `GET /v1/properties/:id` responds with an actual 404 HTTP status for a missing/inaccessible
  // property (assets.controller.ts throws NotFoundException) rather than a 200 with a `null` body — so a
  // bogus id here doesn't resolve `.then(setData)` with null the way e.g. bill/warranty/purchase detail do;
  // it *rejects*. Without catching that and mapping it back to `setData(null)`, the "Not found" branch
  // below was dead code and every bogus/forbidden property id crashed the whole app instead (confirmed
  // live via Playwright). A genuine network/server error still surfaces as an inline message rather than a
  // silent infinite loading skeleton.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<PropertyDetail | null>(`/v1/properties/${id}`)
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
    // `Math.round(Number("abc") * 100)` is NaN, and `JSON.stringify` silently turns NaN into `null` — the
    // record was saved with the cost quietly dropped and no error shown at all (confirmed live: typing
    // "abc" into Cost produced a record with no dollar amount, no warning). Validate client-side instead of
    // letting a typo through as silent data loss.
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
        propertyProfileId: id,
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

  async function remove() {
    setDeleting(true);
    setActionError(null);
    try {
      await api.delete(`/v1/properties/${id}`);
      router.back();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this property. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  // Household-assignment gap close — mirrors person/[id].tsx's identical immediate-save private/household
  // toggle. `PUT /v1/properties/{id}` is the new edit endpoint; `null` explicitly means "make private again".
  async function saveHousehold(householdId: string | null) {
    await api.put(`/v1/properties/${id}`, { householdId });
    load();
  }

  async function addAsset() {
    if (!assetLabel.trim()) return;
    try {
      // HOMEOS-002 "Add rooms as needed... without forcing setup" — free text, no room list to set up first.
      await api.post("/v1/home-assets", { propertyProfileId: id, label: assetLabel, room: assetRoom.trim() || undefined, make: assetMake.trim() || undefined });
      setAssetLabel("");
      setAssetRoom("");
      setAssetMake("");
      setAddingAsset(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that home asset.");
    }
  }

  async function checkAssetRecalls(assetId: string) {
    setCheckingAssetId(assetId);
    try {
      await api.post(`/v1/home-assets/${assetId}/check-recalls`, {});
      load();
    } finally {
      setCheckingAssetId(null);
    }
  }

  async function resolveAssetRecall(recallId: string) {
    await api.post(`/v1/recall-matches/${recallId}/resolve`, {});
    load();
  }

  async function loadAssetRuleTemplates(assetId: string) {
    if (ruleTemplatesByAsset[assetId]) return;
    try {
      const templates = await api.get<MaintenanceRuleTemplate[]>(`/v1/home-assets/${assetId}/maintenance-rule-templates`);
      setRuleTemplatesByAsset((prev) => ({ ...prev, [assetId]: templates }));
    } catch {
      setRuleTemplatesByAsset((prev) => ({ ...prev, [assetId]: [] }));
    }
  }

  async function addAssetRuleFromTemplate(assetId: string, templateKey: string) {
    setActionError(null);
    try {
      await api.post("/v1/maintenance-rules/from-template", { homeAssetId: assetId, templateKey });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that suggested rule.");
    }
  }

  async function addCustomAssetRule(assetId: string) {
    if (!ruleLabel.trim() || !ruleIntervalDays.trim()) return;
    setActionError(null);
    setRuleSubmitting(true);
    try {
      // Home assets have no odometer, so this mini-section (unlike the vehicle detail screen's own
      // maintenance schedule) is always "by time" — matches apps/web's identical restriction.
      await api.post("/v1/maintenance-rules", { homeAssetId: assetId, label: ruleLabel, intervalType: "calendar", intervalDays: Math.round(Number(ruleIntervalDays)) });
      setRuleLabel("");
      setRuleIntervalDays("");
      setAddingRuleForAsset(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that maintenance rule.");
    } finally {
      setRuleSubmitting(false);
    }
  }

  async function completeAssetRule(ruleId: string) {
    setRuleBusyId(ruleId);
    setActionError(null);
    try {
      await api.post(`/v1/maintenance-rules/${ruleId}/complete`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark that done.");
    } finally {
      setRuleBusyId(null);
    }
  }

  async function deleteAssetRule(ruleId: string) {
    setRuleBusyId(ruleId);
    setActionError(null);
    try {
      await api.delete(`/v1/maintenance-rules/${ruleId}`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove that rule.");
    } finally {
      setRuleBusyId(null);
    }
  }

  // Guarded on `data === undefined` (not just `error` alone) so a refetch that fails after this screen
  // already loaded successfully once — `load` reruns on every `useFocusEffect`, e.g. navigating back into
  // this screen — doesn't blow away the already-loaded property view. Mirrors trip/[id].tsx's identical
  // guard.
  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this property"
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
        <EmptyState title="Not found" description="This property doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const { property, warranties, maintenance, homeAssets } = data;
  const moveIn = formatTemporal(property.moveInDate);
  const openRecallCount = homeAssets.reduce((sum, a) => sum + a.recalls.filter((r) => r.status !== "closed_or_repaired").length, 0);

  return (
    <Screen>
      <ScreenHeader
        title={openRecallCount > 0 ? `${property.label} ⚠` : property.label}
        subtitle={[property.address, moveIn ? `Moved in ${moveIn}` : null].filter(Boolean).join(" — ")}
      />

      {/* This screen's `actionError` is shared across recall check/resolve, add home asset, add
          maintenance record, and remove property — but used to render only once, right before the
          "Remove property" button at the very bottom of a long scrollable page (mirrors vehicle/[id].tsx's
          identical bug and fix, confirmed live the same way: an error from an action near the top of the
          page was invisible without scrolling past every card below it). Shown immediately below the
          header instead, matching automations.tsx's top-of-screen placement for its own multi-action
          error. The maintenance-record form below keeps its own inline copy too (useful immediate
          feedback right where that specific form is), guarded so it doesn't also duplicate here. */}
      {actionError && !addingRecord && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {/* Phase 2 §52.2 "object sharing" — mirrors apps/web's properties/[id]/page.tsx. PropertyDetail's
          payload carries no owner id, so (matching documents.tsx's own precedent) the button is always
          shown and the backend's 403 on a non-owner's grant/link attempt does the gating. */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button variant="ghost" onPress={() => setSharing((s) => !s)}>
          Share
        </Button>
      </View>
      {sharing && (
        <Card>
          <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/properties" resourceLabel="property" />
        </Card>
      )}

      <HouseholdPicker mode="edit" value={property.householdId} onSave={saveHousehold} />

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Home assets{openRecallCount > 0 ? ` (${openRecallCount} recall${openRecallCount === 1 ? "" : "s"})` : ""}
          </Text>
          {!addingAsset && (
            <Pressable accessibilityRole="button" onPress={() => setAddingAsset(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add</Text>
            </Pressable>
          )}
        </View>
        {homeAssets.length === 0 && !addingAsset && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No systems or appliances tracked yet.</Text>}
        {homeAssets.map((a) => {
          const openAssetRecalls = a.recalls.filter((r) => r.status !== "closed_or_repaired");
          return (
            <View key={a.id} style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                  {a.label}
                  {a.room ? ` — ${a.room}` : ""}
                  {(a.make || a.model) ? ` — ${[a.make, a.model].filter(Boolean).join(" ")}` : ""}
                </Text>
                <Pressable accessibilityRole="button" onPress={() => checkAssetRecalls(a.id)}>
                  <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.brandDefault }}>
                    {checkingAssetId === a.id ? "Checking…" : "Check recalls"}
                  </Text>
                </Pressable>
              </View>
              {a.maintenanceRules.map((r) => {
                const last = formatTemporal(r.lastPerformedDate);
                const busy = ruleBusyId === r.id;
                return (
                  <View
                    key={r.id}
                    style={{ marginLeft: 8, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 8 }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>{r.label}</Text>
                      <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                        Every {r.intervalDays} days{last && ` — last done ${last}`}
                      </Text>
                      {r.source === "seeded_generic_guidance" && r.confidenceNote && (
                        <Text style={{ fontSize: 11, color: theme.colors.textTertiary, fontStyle: "italic" }}>{r.confidenceNote}</Text>
                      )}
                    </View>
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Pressable accessibilityRole="button" onPress={() => completeAssetRule(r.id)} disabled={busy}>
                        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.brandDefault, opacity: busy ? 0.5 : 1 }}>Mark done</Text>
                      </Pressable>
                      <Pressable accessibilityRole="button" onPress={() => deleteAssetRule(r.id)} disabled={busy}>
                        <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textTertiary, opacity: busy ? 0.5 : 1 }}>Remove</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
              {addingRuleForAsset === a.id ? (
                <View style={{ marginLeft: 8, gap: 6, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 8 }}>
                  {(ruleTemplatesByAsset[a.id]?.length ?? 0) > 0 && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                      {ruleTemplatesByAsset[a.id]!.map((t) => (
                        <Pressable accessibilityRole="button"
                          key={t.key}
                          onPress={() => addAssetRuleFromTemplate(a.id, t.key)}
                          style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault }}
                        >
                          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textPrimary }}>+ {t.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                  <TextField label="Custom rule" placeholder="e.g. Filter change" value={ruleLabel} onChangeText={setRuleLabel} />
                  <TextField label="Every N days" value={ruleIntervalDays} onChangeText={setRuleIntervalDays} keyboardType="number-pad" />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button onPress={() => addCustomAssetRule(a.id)} loading={ruleSubmitting} disabled={!ruleLabel.trim() || !ruleIntervalDays.trim()}>
                        Add
                      </Button>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button variant="secondary" onPress={() => setAddingRuleForAsset(null)}>
                        Cancel
                      </Button>
                    </View>
                  </View>
                </View>
              ) : (
                <Pressable accessibilityRole="button"
                  onPress={() => {
                    setAddingRuleForAsset(a.id);
                    loadAssetRuleTemplates(a.id);
                  }}
                  style={{ marginLeft: 8 }}
                >
                  <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add maintenance rule</Text>
                </Pressable>
              )}
              {a.recalls.map((r) => (
                <View key={r.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingLeft: 8 }}>
                  <Text style={{ fontSize: 11, color: theme.colors.textSecondary, flex: 1 }}>{r.component ?? r.summary}</Text>
                  <Badge tone={RECALL_STATUS_TONE[r.status]}>{RECALL_STATUS_LABEL[r.status]}</Badge>
                  {r.status !== "closed_or_repaired" && (
                    <Pressable accessibilityRole="button" onPress={() => resolveAssetRecall(r.id)}>
                      <Text style={{ fontSize: 11, color: theme.colors.textTertiary, marginLeft: 6 }}>Resolve</Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          );
        })}
        {addingAsset && (
          <View style={{ gap: 8 }}>
            <TextField label="Name" placeholder="e.g. Water heater" value={assetLabel} onChangeText={setAssetLabel} />
            <TextField label="Room (optional)" value={assetRoom} onChangeText={setAssetRoom} />
            <TextField label="Make (optional)" value={assetMake} onChangeText={setAssetMake} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addAsset} disabled={!assetLabel.trim()}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setAddingAsset(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      <Card style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Warranties</Text>
        {warranties.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None linked yet.</Text>}
        {warranties.map((w) => {
          const days = daysUntil(w.expirationDate);
          return (
            <Pressable accessibilityRole="button"
              key={w.id}
              onPress={() => router.push(`/warranty/${w.id}`)}
              style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{w.productLabel}</Text>
              {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
            </Pressable>
          );
        })}
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Maintenance history</Text>
          {!addingRecord && (
            <Pressable accessibilityRole="button" onPress={() => setAddingRecord(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a record</Text>
            </Pressable>
          )}
        </View>
        {maintenance.length === 0 && !addingRecord && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No service history logged yet.</Text>}
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
            <TextField label="Description" placeholder="e.g. Roof repair" value={description} onChangeText={setDescription} />
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
          Remove property
        </Button>
      ) : (
        <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
            This removes {property.label} and its home assets, warranties, and maintenance history. It can&apos;t be undone.
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
