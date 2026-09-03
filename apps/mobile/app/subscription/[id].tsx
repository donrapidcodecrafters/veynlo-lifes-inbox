import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

// SUB-004 "shows known steps ... when a direct API/partner flow doesn't exist" — mirrors apps/web's
// identical interface (see that file's doc comment).
interface CancellationSteps {
  steps: string[];
  sourceNote: string | null;
  source: "user" | "seeded";
  stepsId: string;
}

interface SubscriptionDetail {
  subscription: { state: string; trialEndsAt: TemporalValueLike | null; cancellationInstructionsUrl: string | null };
  stream: {
    merchantId: string | null;
    serviceLabel: string;
    cadence: string;
    typicalAmountMinorUnits: number | null;
    typicalAmountCurrency: string | null;
    essential: boolean | null;
    nextExpectedDate: TemporalValueLike | null;
  };
  // §40.3 "Pause" gap — mirrors apps/web's identical field (see that file's own doc comment): resolved
  // server-side so this screen can honestly hide "Pause" until a real merchant is ever added to
  // pause-capability.ts's currently-empty allowlist.
  merchantName: string | null;
  canPause: boolean;
  priceHistory: Array<{ observedAmountMinorUnits: number; observedAmountCurrency: string; observedAt: string }>;
  cancellationSteps: CancellationSteps | null;
  evidence: Evidence | null;
}

// §40.3 Subscription state machine — mirrors apps/web's identical guards (see that file's own doc comment):
// `submitSubscriptionCancellation`/`pauseSubscription`'s own state checks, kept in sync client-side so a
// button is only ever shown when the POST would actually succeed.
const CANCELABLE_STATES = new Set(["trial", "active", "trial_ended", "price_changed", "renewal_upcoming"]);
const PAUSABLE_STATES = new Set(["active", "trial_ended", "price_changed", "renewal_upcoming"]);

/**
 * §40.3 Subscription state machine — user-initiated `active-like → cancellation_pending`. Mirrors apps/web's
 * identical CancelSubscriptionAction (see that file's doc comment: a real cancellation intent, but one that
 * never contacts the actual merchant — the copy says so explicitly). Inline confirm state, not Alert.alert,
 * matching this app's own established convention.
 */
function CancelSubscriptionAction({ subscriptionId, nextChargeLabel, onSaved }: { subscriptionId: string; nextChargeLabel: string | null; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [confirming, setConfirming] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCancellation() {
    setError(null);
    setCanceling(true);
    try {
      await api.post(`/v1/subscriptions/${subscriptionId}/cancel`);
      setConfirming(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't submit that cancellation.");
    } finally {
      setCanceling(false);
    }
  }

  if (!confirming) {
    return (
      <View style={{ gap: 4 }}>
        <Button variant="critical" onPress={() => setConfirming(true)}>
          Cancel subscription
        </Button>
        {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      </View>
    );
  }

  return (
    <View style={{ gap: 8, backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
      <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
        This marks your subscription canceled in Veynlo{nextChargeLabel ? ` (effective ${nextChargeLabel}, your next charge date)` : ""} — it doesn&apos;t
        contact the merchant for you. Use the steps below, or the merchant&apos;s own site, to actually stop being charged.
      </Text>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button variant="critical" loading={canceling} onPress={submitCancellation}>
            Confirm
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setConfirming(false)}>
            Cancel
          </Button>
        </View>
      </View>
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
    </View>
  );
}

/**
 * §40.3 Subscription state machine — `active-like → paused` / `paused → active`. Mirrors apps/web's
 * identical PauseResumeAction: Pause only shown when the server-resolved `canPause` is true (nothing is
 * seeded as pause-capable today, so this renders nothing for any real subscription right now); Resume is
 * always safe to offer once a subscription genuinely reached "paused."
 */
function PauseResumeAction({ subscriptionId, state, canPause, onSaved }: { subscriptionId: string; state: string; canPause: boolean; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: "pause" | "resume") {
    setError(null);
    setWorking(true);
    try {
      await api.post(`/v1/subscriptions/${subscriptionId}/${action}`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Couldn't ${action} this subscription.`);
    } finally {
      setWorking(false);
    }
  }

  if (state === "paused") {
    return (
      <View style={{ gap: 4 }}>
        <Button variant="secondary" loading={working} onPress={() => run("resume")}>
          Resume subscription
        </Button>
        {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      </View>
    );
  }
  if (canPause && PAUSABLE_STATES.has(state)) {
    return (
      <View style={{ gap: 4 }}>
        <Button variant="secondary" loading={working} onPress={() => run("pause")}>
          Pause subscription
        </Button>
        {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      </View>
    );
  }
  return null;
}

/**
 * SUB-004 "let a user add/correct steps for a merchant themselves" — mirrors apps/web's
 * CancellationStepsEditor (see that file's doc comment), itself mirroring this app's own RET-004
 * PolicyEditor precedent (apps/mobile/app/purchase/[id].tsx).
 */
function CancellationStepsEditor({
  merchantId,
  serviceLabel,
  current,
  onSaved,
}: {
  merchantId: string;
  serviceLabel: string;
  current: CancellationSteps | null;
  onSaved: () => void;
}) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [stepsText, setStepsText] = useState((current?.steps ?? []).join("\n"));
  const [sourceNote, setSourceNote] = useState(current?.source === "user" ? (current.sourceNote ?? "") : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const steps = stepsText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (steps.length === 0) {
      setError("Enter at least one step, one per line.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/merchants/${merchantId}/cancellation-steps`, { steps, sourceNote: sourceNote.trim() === "" ? null : sourceNote.trim() });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Text accessibilityRole="button" style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setOpen(true)}>
        {current?.source === "user" ? "Edit your steps" : `Know how to cancel ${serviceLabel}?`}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.md, padding: 10 }}>
      <TextField
        label="Cancellation steps, one per line"
        value={stepsText}
        onChangeText={setStepsText}
        multiline
        numberOfLines={4}
        style={{ height: 100, textAlignVertical: "top", paddingTop: 10 }}
        placeholder={"Log into your account\nGo to Settings > Subscription\nClick Cancel Plan"}
      />
      <TextField label="Where did this come from? (optional)" value={sourceNote} onChangeText={setSourceNote} placeholder="e.g. Did this myself on 2026-08-15" />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" loading={saving} onPress={save}>
            Save steps
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}

export default function SubscriptionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<SubscriptionDetail | null | undefined>(undefined);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    load();
  }, [id]);

  function load() {
    // `error` must be cleared at the start of every load — not just on success further down — or a
    // successful retry after a failed load leaves `error` (and therefore the FetchError early return
    // above) stuck forever, since nothing else ever resets it. Mirrors bill/[id].tsx's and event/[id].tsx's
    // identical `setError(null)` at the top of `load`.
    setError(null);
    api
      .get<SubscriptionDetail | null>(`/v1/subscriptions/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }

  async function setEssential(essential: boolean) {
    try {
      await api.post(`/v1/subscriptions/${id}/essential`, { essential });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    }
  }

  // Guarded on `data === undefined` (not just `error` alone) so a reload that fails after this screen
  // already loaded successfully once — `setEssential` calls `load()` again on success — doesn't blow away
  // the already-loaded subscription view. Mirrors trip/[id].tsx's identical guard.
  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this subscription"
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
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This subscription doesn't exist or you don't have access to it." /></Screen>;

  const { subscription, stream, canPause, priceHistory, cancellationSteps, evidence } = data;
  const amount = formatMoneyMinorUnits(stream.typicalAmountMinorUnits, stream.typicalAmountCurrency);
  const trialEnds = subscription.state === "trial" ? formatTemporal(subscription.trialEndsAt) : null;
  const trialDaysLeft = subscription.state === "trial" ? daysUntil(subscription.trialEndsAt) : null;
  const nextCharge = subscription.state !== "trial" ? formatTemporal(stream.nextExpectedDate) : null;
  // Used for the cancellation-pending banner below regardless of the trial-gated `nextCharge` above — a
  // canceling subscription is never in the "trial" state (see CANCELABLE_STATES), so this is always the
  // real next-billing date to show as the effective-until date.
  const nextChargeForCancellation = formatTemporal(stream.nextExpectedDate);

  return (
    <Screen>
      <ScreenHeader title={stream.serviceLabel} subtitle={stream.cadence} />
      {/* §40.3 Subscription state machine — mirrors apps/web's identical cancellation-pending banner. */}
      {subscription.state === "cancellation_pending" && (
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Cancellation submitted</Text>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            {nextChargeForCancellation
              ? `This stays active until ${nextChargeForCancellation}, the end of your current billing period, then moves to canceled automatically.`
              : "This will move to canceled once its current billing period ends."}
          </Text>
        </Card>
      )}
      {/* SUB-002 "creates opportunity before charged renewal" — a trial previously looked identical to
          any other subscription past the state badge alone. */}
      {subscription.state === "trial" && trialEnds && (
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
            Trial ends {trialEnds}
            {trialDaysLeft != null ? ` (${trialDaysLeft === 0 ? "today" : `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left`})` : ""}
          </Text>
          {amount && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>You&apos;ll be charged {amount} unless you cancel first.</Text>}
        </Card>
      )}
      <Card style={{ gap: 6 }}>
        {amount && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{amount}</Text>}
        {subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
        {/* SUB-003 trial-ending transition — a calmer "brand" tone, not "warning", since being charged the
            already-disclosed post-trial price on schedule is expected, not a surprise increase. */}
        {subscription.state === "trial_ended" && <Badge tone="brand">Trial ended</Badge>}
        {/* §40.3 Subscription state machine — renewal_upcoming/cancellation_pending/paused previously had
            no badge anywhere on mobile (only price_changed/trial_ended did). */}
        {subscription.state === "renewal_upcoming" && <Badge tone="brand">Renewal upcoming</Badge>}
        {subscription.state === "cancellation_pending" && <Badge tone="warning">Canceling</Badge>}
        {subscription.state === "paused" && <Badge tone="neutral">Paused</Badge>}
        {/* SUB-001 "Shows ... next expected charge" — captured but never rendered anywhere before. */}
        {nextCharge && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Next charge: {nextCharge}</Text>
        )}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Essential: {stream.essential == null ? "Unknown" : stream.essential ? "Yes" : "No"}
        </Text>
        {/* §18 "mark essential/unused" — recurringStreams.essential had a real column but no writer
            anywhere; this was always "Unknown" with no way to change it. */}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {stream.essential !== true && (
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setEssential(true)}>
                Mark essential
              </Button>
            </View>
          )}
          {stream.essential !== false && (
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setEssential(false)}>
                Mark unused
              </Button>
            </View>
          )}
        </View>
        {subscription.cancellationInstructionsUrl ? (
          <Text accessibilityRole="button"
            style={{ fontSize: 13, color: theme.colors.brandDefault }}
            onPress={() => Linking.openURL(subscription.cancellationInstructionsUrl!)}
          >
            Cancellation instructions →
          </Text>
        ) : cancellationSteps ? (
          // SUB-004 "shows known steps ... when a direct API/partner flow doesn't exist" — a curated (or
          // user-corrected) reference process, since this email never stated one.
          <View style={{ gap: 4 }}>
            {cancellationSteps.steps.map((step, i) => (
              <Text key={i} style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                {i + 1}. {step}
              </Text>
            ))}
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              {cancellationSteps.source === "user" ? "Your own correction." : "General known steps, not verified live — check the service's current process before relying on this."}
            </Text>
            {cancellationSteps.sourceNote && (
              <Text style={{ fontSize: 12, fontStyle: "italic", color: theme.colors.textTertiary }}>{cancellationSteps.sourceNote}</Text>
            )}
          </View>
        ) : (
          // SUB-004 "without pretending cancellation is universally automatable" — a real, sayable
          // answer instead of silently omitting any mention of cancellation help.
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            No cancellation link found in your emails yet, and no known steps for this service. Check the service&apos;s website or account settings directly.
          </Text>
        )}
        {/* SUB-004 "let a user add/correct steps for a merchant themselves" — only offered when a merchant
            was actually resolved for this stream. */}
        {stream.merchantId && (
          <CancellationStepsEditor merchantId={stream.merchantId} serviceLabel={stream.serviceLabel} current={cancellationSteps} onSaved={load} />
        )}

        {/* §40.3 Subscription state machine — real UI triggers for submitSubscriptionCancellation/
            pauseSubscription/resumeSubscription, found live via QA to have no button anywhere despite full
            backend support. */}
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10, marginTop: 2 }}>
          {CANCELABLE_STATES.has(subscription.state) && (
            <CancelSubscriptionAction subscriptionId={String(id)} nextChargeLabel={nextChargeForCancellation} onSaved={load} />
          )}
          <PauseResumeAction subscriptionId={String(id)} state={subscription.state} canPause={canPause} onSaved={load} />
        </View>
      </Card>
      {/* SUB-001 "Shows ... price history" — extractSubscription's price-change branch already logs
          every detected change to price_observations; this is the first place it's ever surfaced. */}
      {priceHistory.length > 0 && (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Price history</Text>
          {priceHistory.map((p, i) => (
            <View key={i} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                {formatTemporal({ precision: "instant", instantUtc: p.observedAt, date: null, timezone: null, sourceText: null })}
              </Text>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                {formatMoneyMinorUnits(p.observedAmountMinorUnits, p.observedAmountCurrency)}
              </Text>
            </View>
          ))}
        </Card>
      )}
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
