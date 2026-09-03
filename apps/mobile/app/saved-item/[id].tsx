import { useCallback, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";

const CATEGORIES = ["product", "place", "recipe", "article", "movie_show", "gift_idea", "event", "trip_idea", "how_to", "reference", "document", "generic"] as const;

interface MemoryDetail {
  id: string;
  ownerUserId: string;
  sourceUrl: string | null;
  rawText: string | null;
  title: string | null;
  userNotes: string | null;
  category: string | null;
  classificationState: "pending" | "classified" | "failed" | "skipped";
  pinned: boolean;
  archivedAt: string | null;
  neverResurface: boolean;
  autoArchiveAt: string | null;
  // SAVE-006 "tags, ratings, highlights."
  tags: string[];
  rating: number | null;
  highlights: string[];
}

// SAVE-007 "Archive automatically after..." — same relative quick-picks as the web detail page.
const AUTO_ARCHIVE_QUICK_PICKS = [
  { label: "In 7 days", days: 7 },
  { label: "In 30 days", days: 30 },
  { label: "In 90 days", days: 90 },
] as const;

// SAVE-004 "Contextual resurfacing" — 4 real trigger types, mirroring apps/web's own RESURFACING_RULE_TYPES
// and matching CreateResurfacingRuleDtoSchema's discriminated union (services/api/src/modules/memories/
// dto.ts) exactly.
const RESURFACING_RULE_TYPES = [
  { value: "date", label: "On a date" },
  { value: "person_birthday", label: "Before a birthday" },
  { value: "trip_location", label: "Matching trip" },
  { value: "location_proximity", label: "Near a place" },
] as const;

interface ResurfacingRule {
  id: string;
  triggerType: (typeof RESURFACING_RULE_TYPES)[number]["value"];
  triggerConfig: Record<string, unknown>;
  active: boolean;
  lastFiredAt: string | null;
}

interface MyHousehold {
  household: { id: string; name: string };
}

interface HouseholdDependent {
  id: string;
  displayName: string;
}

interface PlaceRow {
  id: string;
  label: string;
}

interface TripRow {
  id: string;
  destinationLabel: string | null;
  status: string;
}

/** Mirrors apps/web's (app)/saved/[id]/page.tsx — see its own doc comment for §29.1 SAVE-001/002/007. */
export default function SavedItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  // `undefined` = still loading, `null` = confirmed 404/no-access, an object = loaded — the same
  // three-state split pet/[id].tsx, vehicle/[id].tsx, and property/[id].tsx already use. This screen
  // previously used a bare `MemoryDetail | null`, so a real fetch failure (500/network) was
  // indistinguishable from a still-loading screen: both rendered as a blank Screen with the header and
  // nothing else, since `error` was shown but `memory` stayed null with no loading indicator and no
  // "not found" messaging either.
  const [memory, setMemory] = useState<MemoryDetail | null | undefined>(undefined);
  const [userNotes, setUserNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [highlightInput, setHighlightInput] = useState("");
  const [autoArchiveDateText, setAutoArchiveDateText] = useState("");

  // SAVE-004 resurfacing rules — `rules` is this memory's own rows; the other three lists are the owner's
  // existing dependents/places/trips a rule can be keyed against, fetched alongside the memory itself (same
  // "always fetch, it's cheap, owner-scoped" precedent as apps/person/[id].tsx's own dependents fetch).
  const [rules, setRules] = useState<ResurfacingRule[]>([]);
  const [dependents, setDependents] = useState<HouseholdDependent[]>([]);
  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [ruleType, setRuleType] = useState<ResurfacingRule["triggerType"]>("date");
  const [ruleDateText, setRuleDateText] = useState("");
  const [ruleDependentId, setRuleDependentId] = useState("");
  const [ruleDaysBefore, setRuleDaysBefore] = useState("14");
  const [ruleLocationLabel, setRuleLocationLabel] = useState("");
  const [rulePlaceId, setRulePlaceId] = useState("");
  const [addingRule, setAddingRule] = useState(false);
  const dependentsById = new Map(dependents.map((d) => [d.id, d.displayName] as const));
  const placesById = new Map(places.map((p) => [p.id, p.label] as const));
  const upcomingTrips = trips.filter((t) => (t.status === "upcoming" || t.status === "active") && t.destinationLabel);
  // `error` is the initial-load failure only (drives the early-return below); a failed pin/archive/
  // delete on an already-loaded item uses the separate `actionError` so it doesn't blow away the
  // loaded view the user is looking at — same split as pet/[id].tsx's error/actionError pair.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.get<MemoryDetail>(`/v1/memories/${id}`);
      setMemory(data);
      setUserNotes(data.userNotes ?? "");

      const [ruleRows, households, placeRows, tripRows] = await Promise.all([
        api.get<ResurfacingRule[]>(`/v1/memories/${id}/resurfacing-rules`).catch(() => []),
        api.get<MyHousehold[]>("/v1/households").catch(() => []),
        api.get<PlaceRow[]>("/v1/places").catch(() => []),
        api.get<TripRow[]>("/v1/trips").catch(() => []),
      ]);
      setRules(ruleRows);
      setPlaces(placeRows);
      setTrips(tripRows);
      const primaryHouseholdId = households[0]?.household.id;
      setDependents(primaryHouseholdId ? await api.get<HouseholdDependent[]>(`/v1/households/${primaryHouseholdId}/dependents`).catch(() => []) : []);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setMemory(null);
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't load this saved item.");
    } finally {
      setRetrying(false);
    }
  }, [id]);

  async function loadRules() {
    setRules(await api.get<ResurfacingRule[]>(`/v1/memories/${id}/resurfacing-rules`).catch(() => []));
  }

  function canCreateRule(): boolean {
    if (ruleType === "date") return Boolean(ruleDateText.trim());
    if (ruleType === "person_birthday") return Boolean(ruleDependentId);
    if (ruleType === "trip_location") return Boolean(ruleLocationLabel.trim());
    return Boolean(rulePlaceId);
  }

  // Matches CreateResurfacingRuleDtoSchema's discriminated union exactly (services/api/src/modules/
  // memories/dto.ts) — one request shape per triggerType, mirroring apps/web's own createRule.
  async function createRule() {
    if (!canCreateRule()) return;
    setActionError(null);
    if (ruleType === "date") {
      const parsed = new Date(ruleDateText.trim());
      if (Number.isNaN(parsed.getTime())) {
        setActionError("Enter a date as YYYY-MM-DD.");
        return;
      }
    }
    setAddingRule(true);
    try {
      const body =
        ruleType === "date"
          ? { triggerType: "date" as const, dateIso: new Date(ruleDateText.trim()).toISOString() }
          : ruleType === "person_birthday"
            ? { triggerType: "person_birthday" as const, dependentProfileId: ruleDependentId, daysBefore: Number(ruleDaysBefore) || 0 }
            : ruleType === "trip_location"
              ? { triggerType: "trip_location" as const, locationLabel: ruleLocationLabel.trim() }
              : { triggerType: "location_proximity" as const, placeId: rulePlaceId };
      await api.post(`/v1/memories/${id}/resurfacing-rules`, body);
      setRuleDateText("");
      setRuleDependentId("");
      setRuleDaysBefore("14");
      setRuleLocationLabel("");
      setRulePlaceId("");
      await loadRules();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't set that reminder.");
    } finally {
      setAddingRule(false);
    }
  }

  async function removeRule(ruleId: string) {
    setActionError(null);
    try {
      await api.delete(`/v1/memories/resurfacing-rules/${ruleId}`);
      await loadRules();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove that reminder.");
    }
  }

  /** Human-readable detail for one rule's `triggerConfig` — mirrors apps/web's own ruleDetail. */
  function ruleDetail(rule: ResurfacingRule): string {
    const config = rule.triggerConfig;
    if (rule.triggerType === "date") {
      const date = typeof config.date === "string" ? new Date(config.date) : null;
      return date && !Number.isNaN(date.getTime()) ? `Reminds me on ${date.toLocaleDateString()}` : "Reminds me on a date";
    }
    if (rule.triggerType === "person_birthday") {
      const name = typeof config.dependentProfileId === "string" ? dependentsById.get(config.dependentProfileId) : undefined;
      const daysBefore = typeof config.daysBefore === "number" ? config.daysBefore : 14;
      return name ? `Reminds me ${daysBefore} day${daysBefore === 1 ? "" : "s"} before ${name}'s birthday` : "Reminds me before a person's birthday";
    }
    if (rule.triggerType === "trip_location") {
      return typeof config.locationLabel === "string" ? `Reminds me when I plan a trip to ${config.locationLabel}` : "Reminds me when I plan a matching trip";
    }
    const placeLabel = typeof config.placeId === "string" ? placesById.get(config.placeId) : undefined;
    return placeLabel ? `Reminds me when I'm near ${placeLabel}` : "Reminds me when I'm near a saved place";
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function update(patch: Record<string, unknown>) {
    setActionError(null);
    try {
      await api.put(`/v1/memories/${id}`, patch);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update that.");
    }
  }

  async function saveNotes() {
    setSaving(true);
    try {
      await update({ userNotes });
    } finally {
      setSaving(false);
    }
  }

  // SAVE-006 "tags, ratings, highlights" — same whole-value PUT shape as the web detail page.
  async function addTag() {
    const value = tagInput.trim();
    if (!value || !memory || memory.tags.includes(value)) {
      setTagInput("");
      return;
    }
    setTagInput("");
    await update({ tags: [...memory.tags, value] });
  }

  async function removeTag(tag: string) {
    if (!memory) return;
    await update({ tags: memory.tags.filter((t) => t !== tag) });
  }

  async function setRating(rating: number | null) {
    await update({ rating });
  }

  async function addHighlight() {
    const value = highlightInput.trim();
    if (!value || !memory) return;
    setHighlightInput("");
    await update({ highlights: [...memory.highlights, value] });
  }

  async function removeHighlight(index: number) {
    if (!memory) return;
    await update({ highlights: memory.highlights.filter((_, i) => i !== index) });
  }

  // SAVE-007 "auto-archive after a condition" — wired to the existing (already-working) `autoArchiveAt`
  // backend field/scan; this is purely the missing UI control. No native date-picker dependency exists in
  // this app yet, so a specific date is entered as plain YYYY-MM-DD text alongside the relative quick-picks.
  async function setAutoArchiveInDays(days: number) {
    await update({ autoArchiveAtIso: new Date(Date.now() + days * 86_400_000).toISOString() });
  }

  async function setAutoArchiveOnDate() {
    if (!autoArchiveDateText.trim()) return;
    const parsed = new Date(autoArchiveDateText.trim());
    if (Number.isNaN(parsed.getTime())) {
      setActionError("Enter a date as YYYY-MM-DD.");
      return;
    }
    setAutoArchiveDateText("");
    await update({ autoArchiveAtIso: parsed.toISOString() });
  }

  async function clearAutoArchive() {
    await update({ autoArchiveAtIso: null });
  }

  async function deleteMemory() {
    setActionError(null);
    try {
      await api.delete(`/v1/memories/${id}`);
      router.replace("/saved");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't delete this item.");
    }
  }

  // Guarded on `memory === undefined` (not just `error` alone) so a reload that fails after this screen
  // already loaded successfully once — `load` reruns on every `useFocusEffect`, and `update()` also calls
  // it again after a successful pin/archive/category PUT — doesn't blow away the already-loaded item view.
  // Mirrors trip/[id].tsx's identical guard.
  if (error && memory === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this saved item"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (memory === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Saved item" />
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!memory) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This saved item doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title={memory.title ?? memory.sourceUrl ?? "Untitled save"} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {memory.pinned && <Badge tone="warning">Pinned</Badge>}
        {memory.archivedAt && <Badge tone="neutral">Archived</Badge>}
        {memory.classificationState === "pending" && <Badge tone="neutral">Categorizing…</Badge>}
      </View>

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      <Card style={{ gap: 10 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Category</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {CATEGORIES.map((c) => {
            const active = memory.category === c;
            return (
              <Pressable
                key={c}
                onPress={() => update({ category: c })}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{c.replace(/_/g, " ")}</Text>
              </Pressable>
            );
          })}
        </View>

        {memory.sourceUrl && (
          <Pressable onPress={() => Linking.openURL(memory.sourceUrl!)} accessibilityRole="link">
            <Text style={{ fontSize: 14, color: theme.colors.brandDefault }} numberOfLines={2}>
              {memory.sourceUrl}
            </Text>
          </Pressable>
        )}

        {memory.rawText && <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>{memory.rawText}</Text>}

        <TextField label="Notes" placeholder="Why did you save this?" value={userNotes} onChangeText={setUserNotes} multiline />
        <Button variant="secondary" onPress={saveNotes} loading={saving}>
          Save notes
        </Button>
      </Card>

      {/* SAVE-006 "tags, ratings, highlights" — private, owner-only annotations (the API already redacts
          them for any non-owner viewer, same as notes). */}
      <Card style={{ gap: 10 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Rating</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {[1, 2, 3, 4, 5].map((star) => (
            <Pressable
              key={star}
              onPress={() => setRating(memory.rating === star ? null : star)}
              accessibilityRole="button"
              // A bare "★" glyph tells a screen reader nothing on its own — the label spells out what
              // tapping it does, including that tapping the current rating again clears it.
              accessibilityLabel={memory.rating === star ? `Rated ${star} star${star === 1 ? "" : "s"} — tap to clear` : `Rate ${star} star${star === 1 ? "" : "s"}`}
              accessibilityState={{ selected: memory.rating != null && star <= memory.rating }}
            >
              <Text style={{ fontSize: 22, color: memory.rating != null && star <= memory.rating ? theme.colors.warning : theme.colors.textTertiary }}>★</Text>
            </Pressable>
          ))}
        </View>

        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Tags</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {memory.tags.map((tag) => (
            <Pressable
              key={tag}
              onPress={() => removeTag(tag)}
              accessibilityRole="button"
              accessibilityLabel={`Remove tag ${tag}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: theme.colors.bgSubtle }}
            >
              <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{tag}</Text>
              {/* The "×" glyph is folded into the Pressable's own accessibilityLabel above — exposing it too
                  would have VoiceOver read a stray "multiplication sign" after the real label. */}
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }} importantForAccessibility="no">
                ×
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
          <View style={{ flex: 1 }}>
            <TextField label="Add a tag" value={tagInput} onChangeText={setTagInput} onSubmitEditing={addTag} returnKeyType="done" />
          </View>
          <Button variant="secondary" onPress={addTag}>
            Add
          </Button>
        </View>

        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Highlights</Text>
        {memory.highlights.length === 0 ? (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No highlights saved yet.</Text>
        ) : (
          <View style={{ gap: 6 }}>
            {memory.highlights.map((highlight, i) => (
              <View key={i} style={{ backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 10, gap: 4 }}>
                <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>{highlight}</Text>
                <Pressable accessibilityRole="button" onPress={() => removeHighlight(i)}>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Remove</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <TextField label="Add a highlight" placeholder="Quote a passage you want to remember…" value={highlightInput} onChangeText={setHighlightInput} multiline />
        <Button variant="secondary" onPress={addHighlight}>
          Add highlight
        </Button>
      </Card>

      {/* §29.1 SAVE-004 "Contextual resurfacing" — the backend (ResurfacingService) already fires all 4
          trigger types for real; this screen previously had zero UI to create any of them. Mirrors apps/
          web's (app)/saved/[id]/page.tsx Resurfacing card. */}
      <Card style={{ gap: 10 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Resurfacing</Text>
        <Pressable
          onPress={() => update({ neverResurface: !memory.neverResurface })}
          style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: memory.neverResurface }}
        >
          <View
            importantForAccessibility="no"
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              borderWidth: 1,
              borderColor: theme.colors.borderDefault,
              backgroundColor: memory.neverResurface ? theme.colors.brandDefault : "transparent",
            }}
          />
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>Never resurface this automatically</Text>
        </Pressable>

        {rules.length > 0 && (
          <View style={{ gap: 6 }}>
            {rules.map((r) => (
              <View key={r.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
                  {ruleDetail(r)}
                  {!r.active ? " (done)" : ""}
                </Text>
                <Pressable accessibilityRole="button" onPress={() => removeRule(r.id)}>
                  <Text style={{ fontSize: 12, color: theme.colors.critical }}>Remove</Text>
                </Pressable>
              </View>
            ))}
          </View>
        )}

        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.bgSubtle, paddingTop: 10, gap: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Add a reminder</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {RESURFACING_RULE_TYPES.map((t) => {
              const active = ruleType === t.value;
              return (
                <Pressable
                  key={t.value}
                  onPress={() => setRuleType(t.value)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
                >
                  <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{t.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {ruleType === "date" && <TextField label="Date (YYYY-MM-DD)" placeholder="2026-12-25" value={ruleDateText} onChangeText={setRuleDateText} />}

          {ruleType === "person_birthday" &&
            (dependents.length > 0 ? (
              <>
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Person</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {dependents.map((d) => {
                    const active = ruleDependentId === d.id;
                    return (
                      <Pressable
                        key={d.id}
                        onPress={() => setRuleDependentId(d.id)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{d.displayName}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <TextField label="Days before" value={ruleDaysBefore} onChangeText={setRuleDaysBefore} keyboardType="number-pad" />
              </>
            ) : (
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No household members yet. Add one from Settings first.</Text>
            ))}

          {ruleType === "trip_location" && (
            <>
              {upcomingTrips.length > 0 && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {upcomingTrips.map((t) => {
                    const active = ruleLocationLabel === t.destinationLabel;
                    return (
                      <Pressable
                        key={t.id}
                        onPress={() => setRuleLocationLabel(t.destinationLabel ?? "")}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{t.destinationLabel}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
              {/* Free-text is intentional (not a missing picker) — ResurfacingService.evaluateTripLocationRule
                  matches this label against upcoming/active trips at scan time even before a matching trip
                  exists yet ("saved Denver restaurants surface while planning a Denver trip" works before
                  the trip is booked); the quick-picks above cover matching an existing trip exactly. */}
              <TextField label="Destination" placeholder="e.g. Denver" value={ruleLocationLabel} onChangeText={setRuleLocationLabel} />
            </>
          )}

          {ruleType === "location_proximity" &&
            (places.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                {places.map((p) => {
                  const active = rulePlaceId === p.id;
                  return (
                    <Pressable
                      key={p.id}
                      onPress={() => setRulePlaceId(p.id)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{p.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No saved places yet. Save one from the Places screen first.</Text>
            ))}

          <Button variant="secondary" onPress={createRule} loading={addingRule} disabled={!canCreateRule()}>
            Add reminder
          </Button>
        </View>
      </Card>

      {/* SAVE-007 "auto-archive after a condition" — the backend field/scan already worked; this is the
          missing UI control to actually set it. */}
      <Card style={{ gap: 10 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Archive automatically after…</Text>
        {memory.autoArchiveAt ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>
              Scheduled for {new Date(memory.autoArchiveAt).toLocaleDateString()}
            </Text>
            <Pressable accessibilityRole="button" onPress={clearAutoArchive}>
              <Text style={{ fontSize: 13, color: theme.colors.critical }}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {AUTO_ARCHIVE_QUICK_PICKS.map((pick) => (
                <Button key={pick.days} variant="secondary" onPress={() => setAutoArchiveInDays(pick.days)}>
                  {pick.label}
                </Button>
              ))}
            </View>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
              <View style={{ flex: 1 }}>
                <TextField label="Or a specific date (YYYY-MM-DD)" placeholder="2026-12-31" value={autoArchiveDateText} onChangeText={setAutoArchiveDateText} />
              </View>
              <Button variant="secondary" onPress={setAutoArchiveOnDate}>
                Set
              </Button>
            </View>
          </>
        )}
      </Card>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        <Button variant="secondary" onPress={() => update({ pinned: !memory.pinned })}>
          {memory.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button variant="secondary" onPress={() => update({ archived: !memory.archivedAt })}>
          {memory.archivedAt ? "Unarchive" : "Archive"}
        </Button>
        <Button variant="critical" onPress={deleteMemory}>
          Delete
        </Button>
      </View>
    </Screen>
  );
}
