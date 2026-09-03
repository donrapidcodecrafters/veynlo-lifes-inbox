import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAudioRecorder, useAudioRecorderState, requestRecordingPermissionsAsync, setAudioModeAsync, RecordingPresets } from "expo-audio";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { TextField } from "@/components/text-field";
import { REMINDER_OPTIONS, PROVIDER_LABEL as CALENDAR_PROVIDER_LABEL } from "@/lib/calendar-destinations";

// RET-004 "Policy engine ... deadline calculator" — mirrors apps/web's identical shape (see that file's
// InboxPriceAdjustment doc comment). Only present on category "price_adjustment" items.
interface InboxPriceAdjustment {
  deadline: string;
  daysLeft: number;
  windowDays: number;
  policyConfidence: "user_confirmed" | "commonly_known" | "assumed";
  policySourceNote: string | null;
}

const POLICY_CONFIDENCE_LABEL: Record<InboxPriceAdjustment["policyConfidence"], string> = {
  user_confirmed: "You confirmed this policy",
  commonly_known: "Publicly documented policy",
  assumed: "Unconfirmed — using Veynlo's default",
};
const POLICY_CONFIDENCE_TONE: Record<InboxPriceAdjustment["policyConfidence"], "positive" | "brand" | "neutral"> = {
  user_confirmed: "positive",
  commonly_known: "brand",
  assumed: "neutral",
};

// §52.1 "voice note" transcription — mirrors apps/web's identical shape. `pending: true` means the
// background transcription job (or classification of its resulting transcript) hasn't finished yet — this
// is what drives the poll-until-settled effect below; `pending: false` with `transcript: null` means
// transcription genuinely couldn't produce anything (silence, corrupted audio) and is a stable end state,
// not something to keep polling for. Only present on category "voice_note" items.
interface InboxVoiceNote {
  transcript: string | null;
  pending: boolean;
}

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  linkedResourceType: string | null;
  priceAdjustment?: InboxPriceAdjustment;
  voiceNote?: InboxVoiceNote;
  // CAL-003 "email-vs-calendar date disagreement" — action-id strings (e.g. "use_email_date",
  // "keep_calendar_date") this item additionally offers, beyond the always-shown confirm/snooze/archive/
  // dismiss below. Absent/empty for every other item type.
  suggestedActions?: string[];
}

interface CalendarDestination {
  id: string;
  provider: string;
}

const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

interface CorrectionField {
  key: string;
  label: string;
  numeric?: boolean;
}

// One entry per linkedResourceType InboxService.correct() knows how to handle — keep in sync with
// services/api/src/modules/attention/dto.ts and the web Inbox page's identical table.
const CORRECTION_FIELDS: Record<string, CorrectionField[]> = {
  purchase: [
    { key: "orderNumber", label: "Order number" },
    { key: "totalMinorUnits", label: "Total (in cents)", numeric: true },
    { key: "totalCurrency", label: "Currency (e.g. USD)" },
    { key: "purchaseDateIso", label: "Purchase date (YYYY-MM-DD)" },
  ],
  bill: [
    { key: "billerLabel", label: "Biller name" },
    { key: "amountDueMinorUnits", label: "Amount due (in cents)", numeric: true },
    { key: "amountDueCurrency", label: "Currency (e.g. USD)" },
    { key: "dueDateIso", label: "Due date (YYYY-MM-DD)" },
  ],
  calendar_event: [
    { key: "title", label: "Title" },
    { key: "location", label: "Location" },
    { key: "startIso", label: "Start time (YYYY-MM-DDTHH:MM, UTC)" },
  ],
  shipment: [
    { key: "carrier", label: "Carrier" },
    { key: "trackingNumber", label: "Tracking number" },
    { key: "status", label: "Status" },
  ],
  warranty: [
    { key: "productLabel", label: "Product" },
    { key: "warrantyLengthMonths", label: "Warranty length (months)", numeric: true },
    { key: "expirationDateIso", label: "Expiration date (YYYY-MM-DD)" },
  ],
  subscription: [
    { key: "serviceLabel", label: "Service name" },
    { key: "typicalAmountMinorUnits", label: "Amount (in cents)", numeric: true },
    { key: "typicalAmountCurrency", label: "Currency (e.g. USD)" },
  ],
};

export default function InboxScreen() {
  const { theme } = useAppTheme();
  const { t } = useTranslation("translation", { keyPrefix: "inbox" });
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [addingToCalendarId, setAddingToCalendarId] = useState<string | null>(null);
  // CAL-004 "offer, don't auto-apply" — the review step for an offered reschedule (`["apply_change",
  // "dismiss"]` suggestedActions — see InboxService.applyRescheduleChange).
  const [applyingRescheduleId, setApplyingRescheduleId] = useState<string | null>(null);
  const [calendarDestinations, setCalendarDestinations] = useState<CalendarDestination[]>([]);
  const [capturing, setCapturing] = useState(false);
  // Phase 2 §52.2 "bulk management" — spec §37.1's own example ("12 receipts found... one rule-level
  // question instead of 12 repetitive confirmations") is a MOBILE example, so this belongs here just as
  // much as the web Inbox page's identical bulk confirm/dismiss.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  // Found live: act() / snooze() below fire an api.post from a bare onPress with no try/catch, and
  // bulkAct's try/finally had no catch either (still lets the rejection propagate unhandled) — same
  // crash-overlay bug class as load() above, on the confirm/archive/dismiss/snooze/bulk actions themselves.
  const [actionError, setActionError] = useState<string | null>(null);
  // INB-002 — mirrors web's identical fix (see its own comment): the API already returns {succeeded,
  // failed} on a bulk action, but this screen discarded it entirely, so a partial failure looked
  // identical to full success. A failed id only ever means "not found or not yours," so the copy below
  // doesn't promise a retry will help.
  const [bulkResultNote, setBulkResultNote] = useState<string | null>(null);
  // Distinct from the 401/session-race swallow below — a transient 500/network error previously fell into
  // that same swallow and left `items` null forever with no visible error (see index.tsx's identical fix).
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Same fix as apps/mobile/app/(tabs)/index.tsx's `load()` (see its comment for the full story) — this
    // one is called the same fire-and-forget way from `useFocusEffect` below, so it's exposed to the exact
    // same crash: an in-flight request losing a race with sign-out/session-expiry threw an unhandled
    // ApiError and brought down the whole screen with a full "Uncaught Error" overlay, reproduced live via
    // Settings' delete-account flow.
    try {
      const res = await api.get<InboxItem[]>("/v1/inbox?reviewState=new");
      setItems(res);
      setLoadError(null);
      // CAL-002 destination picker — write-back-enabled calendar connections. Best-effort: a failure here
      // just leaves the picker showing "Life Inbox only," it doesn't block the rest of the screen loading.
      try {
        const connections = await api.get<{ id: string; provider: string; writeBackEnabled: boolean }[]>("/v1/connectors");
        setCalendarDestinations(connections.filter((c) => (c.provider === "google_calendar" || c.provider === "microsoft_calendar") && c.writeBackEnabled));
      } catch {
        // ignore — see comment above
      }
    } catch (err) {
      // A 401 is fully handled by api-client.ts's own redirect — surfacing it here too would just flash
      // before the redirect lands, so it stays swallowed; anything else needs a visible error + retry.
      if (!(err instanceof ApiError) || err.status !== 401) {
        setLoadError(err instanceof ApiError ? err.message : "Please check your connection and try again.");
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // §52.1 "voice note" transcription — mirrors app/data-export/index.tsx's identical poll-while-pending
  // pattern: transcription runs in a background worker (see IngestionService.processVoiceTranscription),
  // so a captured voice note's transcript/classification result may not be ready yet the moment this
  // screen first loads it. Polls every 3s only while at least one voice_note item is still pending, and
  // stops the instant none are — never polls indefinitely, and does nothing at all for accounts with no
  // pending voice notes.
  const voiceNotePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const hasPendingVoiceNote = items?.some((i) => i.category === "voice_note" && i.voiceNote?.pending) ?? false;
    if (hasPendingVoiceNote && !voiceNotePollRef.current) {
      voiceNotePollRef.current = setInterval(load, 3000);
    } else if (!hasPendingVoiceNote && voiceNotePollRef.current) {
      clearInterval(voiceNotePollRef.current);
      voiceNotePollRef.current = null;
    }
    return () => {
      if (voiceNotePollRef.current) {
        clearInterval(voiceNotePollRef.current);
        voiceNotePollRef.current = null;
      }
    };
  }, [items, load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    setActionError(null);
    try {
      await api.post(`/v1/inbox/${id}/${action}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this item. Please try again.");
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (!items) return;
    setSelectedIds((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))));
  }

  async function bulkAct(action: "confirm" | "dismiss") {
    setBulkActing(true);
    setActionError(null);
    setBulkResultNote(null);
    try {
      const result = await api.post<{ succeeded: number; failed: string[] }>(`/v1/inbox/bulk/${action}`, { ids: [...selectedIds] });
      if (result.failed.length > 0) {
        setBulkResultNote(
          `${result.succeeded} of ${result.succeeded + result.failed.length} items updated. ${result.failed.length} couldn't be updated — they may already be gone or no longer yours.`,
        );
        setSelectedIds(new Set(result.failed));
      } else {
        setSelectedIds(new Set());
      }
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update these items. Please try again.");
    } finally {
      setBulkActing(false);
    }
  }

  async function snooze(id: string) {
    setActionError(null);
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    try {
      await api.post(`/v1/inbox/${id}/snooze`, { until });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't snooze this item. Please try again.");
    }
  }

  // CAL-003 — resolves an email-vs-calendar date disagreement; only offered when the item's
  // suggestedActions includes the matching choice (see the two conditional buttons below).
  async function resolveDateDisagreement(id: string, choice: "use_email_date" | "keep_calendar_date") {
    setActionError(null);
    try {
      await api.post(`/v1/inbox/${id}/resolve-date-disagreement`, { choice });
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this item. Please try again.");
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }} accessibilityRole="header">
            {t("title")}
          </Text>
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>{t("subtitle")}</Text>
        </View>
        <Button variant="secondary" onPress={() => setCapturing((v) => !v)}>
          {capturing ? t("cancel") : t("addManually")}
        </Button>
      </View>

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {bulkResultNote && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 10 }}>
          <Text style={{ fontSize: 13, color: theme.colors.warningSubtleText }}>{bulkResultNote}</Text>
        </View>
      )}

      {capturing && (
        <Card style={{ gap: 12 }}>
          <CaptureForm
            onDone={() => {
              setCapturing(false);
              load();
            }}
          />
        </Card>
      )}

      {/* Found live: apps/web's inbox page shows two pulsing skeleton bars while `isLoading`, but this
          screen showed nothing at all while `items` was still null — just a blank gap below the header
          until the first `/v1/inbox` response landed, indistinguishable from "nothing to review". */}
      {!items && !loadError && (
        <View style={{ gap: 12 }}>
          <View style={{ height: 96, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={{ height: 96, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
        </View>
      )}

      {!items && loadError && <FetchError what="your inbox" message={loadError} onRetry={load} />}

      {items?.length === 0 && <EmptyState title={t("caughtUpTitle")} description={t("caughtUpDescription")} />}

      {items && items.length > 0 && (
        <View style={{ gap: 12 }}>
          <Pressable
            onPress={toggleSelectAll}
            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 4 }}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: items.length > 0 && selectedIds.size === items.length }}
            accessibilityLabel="Select all items"
          >
            <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
            </Text>
            {selectedIds.size > 0 && (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button onPress={() => bulkAct("confirm")} loading={bulkActing}>
                  Confirm
                </Button>
                <Button variant="ghost" onPress={() => bulkAct("dismiss")} loading={bulkActing}>
                  Dismiss
                </Button>
              </View>
            )}
          </Pressable>
          {items.map((item) => {
            const fields = item.linkedResourceType ? CORRECTION_FIELDS[item.linkedResourceType] : undefined;
            const isCorrecting = correctingId === item.id;
            const isAddingToCalendar = addingToCalendarId === item.id;
            const isApplyingReschedule = applyingRescheduleId === item.id;
            const isOfferedReschedule = item.suggestedActions?.includes("apply_change") ?? false;
            return (
              <Card key={item.id} style={{ gap: 12 }}>
                <Pressable
                  onPress={() => toggleSelected(item.id)}
                  style={{ flexDirection: "row", gap: 10 }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selectedIds.has(item.id) }}
                  accessibilityLabel={`Select ${item.summary}`}
                >
                  {/* The checkbox square itself is purely decorative — its state is already carried by the
                      row's own accessibilityState above, so exposing it separately would just double up the
                      "checked"/"not checked" announcement. */}
                  <View
                    importantForAccessibility="no"
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 4,
                      borderWidth: 1.5,
                      borderColor: selectedIds.has(item.id) ? theme.colors.brandDefault : theme.colors.borderDefault,
                      backgroundColor: selectedIds.has(item.id) ? theme.colors.brandDefault : "transparent",
                      marginTop: 2,
                    }}
                  />
                  <View style={{ gap: 6, flex: 1 }}>
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Badge>{item.category}</Badge>
                      <Badge tone={CONFIDENCE_TONE[item.confidenceBand] ?? "neutral"}>{item.confidenceBand.replace("_", " ")}</Badge>
                    </View>
                    <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{item.summary}</Text>
                    {/* §52.1 "voice note" transcription — replaces the static "New voice note captured"
                        summary with the real transcript once transcription finishes, and shows an honest
                        in-progress/couldn't-transcribe state otherwise (see the poll-while-pending effect
                        above for how this gets refreshed without a manual pull-to-refresh). */}
                    {item.category === "voice_note" &&
                      (item.voiceNote?.pending ? (
                        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, fontStyle: "italic" }}>Transcribing…</Text>
                      ) : item.voiceNote?.transcript ? (
                        <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>“{item.voiceNote.transcript}”</Text>
                      ) : (
                        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, fontStyle: "italic" }}>
                          Couldn't transcribe this recording — it's still saved and playable.
                        </Text>
                      ))}
                    {/* RET-004 "deadline calculator" + "policy confidence" — mirrors apps/web's identical block. */}
                    {item.priceAdjustment && (
                      <View style={{ gap: 4 }}>
                        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                          <Badge tone={POLICY_CONFIDENCE_TONE[item.priceAdjustment.policyConfidence]}>
                            {POLICY_CONFIDENCE_LABEL[item.priceAdjustment.policyConfidence]}
                          </Badge>
                        </View>
                        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>
                          {item.priceAdjustment.daysLeft > 0
                            ? `${item.priceAdjustment.daysLeft} day${item.priceAdjustment.daysLeft === 1 ? "" : "s"} left to request a price adjustment`
                            : item.priceAdjustment.daysLeft === 0
                              ? "Last day to request a price adjustment"
                              : "Price-adjustment window likely passed"}
                        </Text>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                          Deadline {new Date(item.priceAdjustment.deadline).toLocaleDateString()} ({item.priceAdjustment.windowDays}-day window)
                        </Text>
                      </View>
                    )}
                  </View>
                </Pressable>
                {!isCorrecting && !isAddingToCalendar && !isApplyingReschedule && (
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    {!isOfferedReschedule && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button onPress={() => act(item.id, "confirm")}>Confirm</Button>
                      </View>
                    )}
                    {item.linkedResourceType === "calendar_event" && !isOfferedReschedule && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button variant="secondary" onPress={() => setAddingToCalendarId(item.id)}>
                          Add to calendar
                        </Button>
                      </View>
                    )}
                    {isOfferedReschedule && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button onPress={() => setApplyingRescheduleId(item.id)}>Review change</Button>
                      </View>
                    )}
                    {fields && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button variant="secondary" onPress={() => setCorrectingId(item.id)}>
                          Correct
                        </Button>
                      </View>
                    )}
                    {item.suggestedActions?.includes("use_email_date") && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button variant="secondary" onPress={() => resolveDateDisagreement(item.id, "use_email_date")}>
                          Use email date
                        </Button>
                      </View>
                    )}
                    {item.suggestedActions?.includes("keep_calendar_date") && (
                      <View style={{ flex: 1, minWidth: 90 }}>
                        <Button variant="secondary" onPress={() => resolveDateDisagreement(item.id, "keep_calendar_date")}>
                          Keep calendar date
                        </Button>
                      </View>
                    )}
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button variant="secondary" onPress={() => snooze(item.id)}>
                        Snooze 1w
                      </Button>
                    </View>
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button variant="secondary" onPress={() => act(item.id, "archive")}>
                        Archive
                      </Button>
                    </View>
                    <View style={{ flex: 1, minWidth: 90 }}>
                      <Button variant="ghost" onPress={() => act(item.id, "dismiss")}>
                        Dismiss
                      </Button>
                    </View>
                  </View>
                )}
                {isCorrecting && fields && (
                  <CorrectionForm
                    itemId={item.id}
                    fields={fields}
                    onDone={() => {
                      setCorrectingId(null);
                      load();
                    }}
                    onCancel={() => setCorrectingId(null)}
                  />
                )}
                {isAddingToCalendar && (
                  <AddToCalendarForm
                    itemId={item.id}
                    destinations={calendarDestinations}
                    onDone={() => {
                      setAddingToCalendarId(null);
                      load();
                    }}
                    onCancel={() => setAddingToCalendarId(null)}
                  />
                )}
                {isApplyingReschedule && (
                  <ApplyRescheduleForm
                    itemId={item.id}
                    onDone={() => {
                      setApplyingRescheduleId(null);
                      load();
                    }}
                    onCancel={() => setApplyingRescheduleId(null)}
                  />
                )}
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

/** Mirrors the web Inbox page's identical form — pastes a receipt/bill/confirmation email's text through the same pipeline a real connected inbox uses. */
function CaptureForm({ onDone }: { onDone: () => void }) {
  const { theme } = useAppTheme();
  const [mode, setMode] = useState<"text" | "url" | "voice">("text");
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [url, setUrl] = useState("");
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 200);

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "url") {
        await api.post("/v1/ingestion/url", { url });
      } else if (mode === "voice") {
        if (!recordingUri) return;
        await api.upload("/v1/ingestion/voice-note", {}, { uri: recordingUri, name: "voice-note.m4a", type: "audio/m4a" });
      } else {
        await api.post("/v1/ingestion/manual", { subject, bodyText, fromAddress: fromAddress || undefined });
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onToggleRecording() {
    setError(null);
    if (recorderState.isRecording) {
      await recorder.stop();
      setRecordingUri(recorder.uri);
      return;
    }
    const { granted } = await requestRecordingPermissionsAsync();
    if (!granted) {
      setError("Veynlo needs microphone access to record a voice note.");
      return;
    }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    setRecordingUri(null);
    await recorder.prepareToRecordAsync();
    recorder.record();
  }

  if (done) {
    return (
      <View style={{ gap: 10 }}>
        <Text style={{ fontSize: 15, color: theme.colors.textPrimary }}>
          {mode === "voice"
            ? "Saved. It's transcribed automatically in the background — the card below will update with the transcript in a moment."
            : "Submitted. If Veynlo finds something worth reviewing in it, a card will appear here shortly."}
        </Text>
        <Button onPress={onDone}>Done</Button>
      </View>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 6, padding: 4, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md }}>
        {(["text", "url", "voice"] as const).map((m) => {
          const active = mode === m;
          return (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={{
                flex: 1,
                paddingVertical: 8,
                borderRadius: theme.radius.sm,
                backgroundColor: active ? theme.colors.bgSurface : "transparent",
                alignItems: "center",
              }}
            >
              <Text
                style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}
                maxFontSizeMultiplier={1.6}
              >
                {m === "text" ? "Paste text" : m === "url" ? "From a URL" : "Voice note"}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {mode === "text" && (
        <>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Paste the text of a receipt, bill, confirmation, or other email — or just describe what happened.
          </Text>
          <TextField label="Subject" value={subject} onChangeText={setSubject} />
          <TextField label="From (optional)" value={fromAddress} onChangeText={setFromAddress} autoCapitalize="none" keyboardType="email-address" />
          <TextField
            label="Content"
            value={bodyText}
            onChangeText={setBodyText}
            multiline
            numberOfLines={6}
            style={{ height: 140, paddingTop: 12, textAlignVertical: "top" }}
          />
        </>
      )}

      {mode === "url" && (
        <>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Paste a link to a confirmation page, event listing, or anything else worth remembering.
          </Text>
          <TextField
            label="URL"
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="https://example.com/order/12345"
          />
        </>
      )}

      {mode === "voice" && (
        <>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Record a quick voice note. It's saved and playable from your Inbox, and automatically transcribed in the
            background — if Veynlo finds something worth reviewing in the transcript, a card will appear for it too.
          </Text>
          <Pressable
            onPress={onToggleRecording}
            accessibilityRole="button"
            // The visible text itself changes every second while recording (elapsed seconds ticking up),
            // which would make VoiceOver re-announce the whole label constantly — the spoken label instead
            // just states the action, with the live duration left to the visible text for sighted users.
            accessibilityLabel={recorderState.isRecording ? "Stop recording" : "Start recording"}
            style={{
              alignItems: "center",
              justifyContent: "center",
              paddingVertical: 20,
              borderRadius: theme.radius.md,
              backgroundColor: recorderState.isRecording ? theme.colors.criticalSubtleBg : theme.colors.bgSubtle,
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: "600", color: recorderState.isRecording ? theme.colors.critical : theme.colors.textPrimary }}>
              {recorderState.isRecording ? `● Stop recording (${Math.floor(recorderState.durationMillis / 1000)}s)` : "🎙️ Start recording"}
            </Text>
          </Pressable>
          {recordingUri && !recorderState.isRecording && (
            <Text style={{ fontSize: 13, color: theme.colors.positive }}>Recorded — ready to submit.</Text>
          )}
        </>
      )}

      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <Button
        onPress={onSubmit}
        loading={submitting}
        disabled={mode === "text" ? !subject || !bodyText : mode === "url" ? !url : !recordingUri || recorderState.isRecording}
      >
        Submit
      </Button>
    </View>
  );
}

function CorrectionForm({
  itemId,
  fields,
  onDone,
  onCancel,
}: {
  itemId: string;
  fields: CorrectionField[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { theme } = useAppTheme();
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // MAIL-006 "From Inbox: Always treat messages from this sender as..." — see apps/web's identical
  // CorrectionForm addition (inbox/page.tsx) for the full contract; InboxService.addSenderRuleFromInboxItem
  // does the actual work.
  const [senderRuleAction, setSenderRuleAction] = useState<string | null>(null);
  const [applyingSenderRule, setApplyingSenderRule] = useState(false);
  const [senderRuleError, setSenderRuleError] = useState<string | null>(null);
  const [senderRuleDone, setSenderRuleDone] = useState(false);

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, string | number> = {};
      for (const field of fields) {
        const raw = values[field.key];
        if (!raw) continue; // blank means "leave unchanged" — only send fields the user actually filled in
        patch[field.key] = field.numeric ? Number(raw) : raw;
      }
      if (Object.keys(patch).length === 0) {
        setError("Enter at least one corrected value, or Cancel.");
        setSubmitting(false);
        return;
      }
      await api.post(`/v1/inbox/${itemId}/correct`, patch);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  async function applySenderRule() {
    if (!senderRuleAction) return;
    setApplyingSenderRule(true);
    setSenderRuleError(null);
    try {
      await api.post(`/v1/inbox/${itemId}/sender-rule`, { action: senderRuleAction });
      setSenderRuleDone(true);
    } catch (err) {
      setSenderRuleError(err instanceof ApiError ? err.message : "Couldn't create that rule.");
    } finally {
      setApplyingSenderRule(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        Only fill in the fields that are wrong — everything else stays as extracted.
      </Text>
      {fields.map((field) => (
        <TextField
          key={field.key}
          label={field.label}
          value={values[field.key] ?? ""}
          onChangeText={(text) => setValues((v) => ({ ...v, [field.key]: text }))}
          keyboardType={field.numeric ? "numeric" : "default"}
          autoCapitalize="none"
        />
      ))}
      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={onSave} loading={submitting}>
            Save correction
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </View>
      </View>

      <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 10 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Always treat mail from this sender as</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {SENDER_RULE_ACTIONS.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => setSenderRuleAction(opt.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: senderRuleAction === opt.value }}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 10,
                borderRadius: theme.radius.sm,
                borderWidth: 1,
                borderColor: senderRuleAction === opt.value ? theme.colors.brandDefault : theme.colors.borderDefault,
                backgroundColor: senderRuleAction === opt.value ? theme.colors.brandDefault : "transparent",
              }}
            >
              <Text
                style={{ fontSize: 12, fontWeight: "600", color: senderRuleAction === opt.value ? theme.colors.textOnBrand : theme.colors.textPrimary }}
                maxFontSizeMultiplier={1.6}
              >
                {opt.label}
              </Text>
            </Pressable>
          ))}
        </View>
        <Button variant="secondary" onPress={applySenderRule} loading={applyingSenderRule} disabled={!senderRuleAction}>
          Apply
        </Button>
        {senderRuleDone && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Saved — see Settings → Sender rules.</Text>}
        {senderRuleError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{senderRuleError}</Text>}
      </View>
    </View>
  );
}

const SENDER_RULE_ACTIONS = [
  { value: "always_school", label: "School" },
  { value: "always_bills", label: "Bills" },
  { value: "ignore", label: "Ignore" },
  { value: "attachments_only", label: "Attachments only" },
  { value: "household_shared", label: "Household shared" },
];

/** CAL-002 "offers Add to calendar with chosen destination and reminder defaults" — see apps/web's
 * identical `AddToCalendarForm` (inbox/page.tsx) for the full contract. No native `<select>` on mobile, so
 * destination/reminder are each a wrapping row of chip-style buttons instead of a dropdown. */
function AddToCalendarForm({
  itemId,
  destinations,
  onDone,
  onCancel,
}: {
  itemId: string;
  destinations: CalendarDestination[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { theme } = useAppTheme();
  const [destinationConnectionId, setDestinationConnectionId] = useState<string>("");
  const [reminderMinutesBefore, setReminderMinutesBefore] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/inbox/${itemId}/add-to-calendar`, {
        destinationConnectionId: destinationConnectionId || null,
        reminderMinutesBefore,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  function Chip({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) {
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        style={{
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: selected ? theme.colors.brandDefault : theme.colors.borderDefault,
          backgroundColor: selected ? theme.colors.brandDefault : "transparent",
        }}
      >
        <Text
          style={{ fontSize: 12, fontWeight: "600", color: selected ? theme.colors.textOnBrand : theme.colors.textPrimary }}
          maxFontSizeMultiplier={1.6}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary }}>DESTINATION</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <Chip selected={destinationConnectionId === ""} label="Life Inbox only" onPress={() => setDestinationConnectionId("")} />
          {destinations.map((d) => (
            <Chip
              key={d.id}
              selected={destinationConnectionId === d.id}
              label={CALENDAR_PROVIDER_LABEL[d.provider] ?? d.provider}
              onPress={() => setDestinationConnectionId(d.id)}
            />
          ))}
        </View>
        {destinations.length === 0 && (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            No connected calendars have write-back turned on yet — this event stays in Life Inbox only.
          </Text>
        )}
      </View>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary }}>REMIND ME</Text>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {REMINDER_OPTIONS.map((opt) => (
            <Chip key={opt.value} selected={reminderMinutesBefore === opt.value} label={opt.label} onPress={() => setReminderMinutesBefore(opt.value)} />
          ))}
        </View>
      </View>
      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={onSave} loading={submitting}>
            Confirm
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}

/**
 * CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — the review step
 * behind an offered reschedule's "Review change" button, mirroring apps/web's identical form. `trustSender`
 * is the "Always trust reschedule emails like this one" opt-in, reachable right here — the natural place a
 * user would opt in, at the moment they see the first legitimate reschedule from a given sender (see
 * InboxService.applyRescheduleChange).
 */
function ApplyRescheduleForm({ itemId, onDone, onCancel }: { itemId: string; onDone: () => void; onCancel: () => void }) {
  const { theme } = useAppTheme();
  const [trustSender, setTrustSender] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/inbox/${itemId}/apply-reschedule`, { trustSender });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <Pressable
        onPress={() => setTrustSender((v) => !v)}
        style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: trustSender }}
      >
        <View
          importantForAccessibility="no"
          style={{
            width: 20,
            height: 20,
            borderRadius: 4,
            borderWidth: 1.5,
            borderColor: trustSender ? theme.colors.brandDefault : theme.colors.borderDefault,
            backgroundColor: trustSender ? theme.colors.brandDefault : "transparent",
          }}
        />
        <Text style={{ fontSize: 13, color: theme.colors.textSecondary, flex: 1 }}>Always trust reschedule emails like this one</Text>
      </Pressable>
      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={onSave} loading={submitting}>
            Apply change
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}
