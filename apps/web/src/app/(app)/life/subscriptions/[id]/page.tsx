"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

// Same mapping the Life list page uses for subscription state — a paused, canceled, or expired
// subscription previously showed no badge at all here (only "price_changed" did).
const STATE_TONE: Record<string, "positive" | "warning" | "neutral" | "info" | "critical"> = {
  candidate: "neutral",
  trial: "info",
  active: "positive",
  renewal_upcoming: "info",
  price_changed: "warning",
  // SUB-003 trial-ending transition — a calmer "info" tone (matching "trial"), not "warning", since being
  // charged the disclosed post-trial price on schedule is expected, not a surprise increase.
  trial_ended: "info",
  paused: "neutral",
  cancellation_pending: "warning",
  canceled: "neutral",
  expired: "neutral",
};

// SUB-004 "shows known steps ... when a direct API/partner flow doesn't exist" — resolved server-side by
// CommerceService.subscriptionDetail from the stream's merchant (see merchant-cancellation-steps.ts).
interface CancellationSteps {
  steps: string[];
  sourceNote: string | null;
  source: "user" | "seeded";
  stepsId: string;
}

interface SubscriptionDetail {
  subscription: { id: string; state: string; trialEndsAt: TemporalValueLike | null; cancellationInstructionsUrl: string | null };
  stream: {
    merchantId: string | null;
    serviceLabel: string;
    cadence: string;
    typicalAmountMinorUnits: number | null;
    typicalAmountCurrency: string | null;
    essential: boolean | null;
    nextExpectedDate: TemporalValueLike | null;
  };
  // §40.3 "Pause" gap — CommerceService.subscriptionDetail resolves merchantSupportsPause server-side (see
  // its own doc comment) so this page can honestly hide "Pause" until a real merchant is ever added to
  // pause-capability.ts's currently-empty allowlist, instead of showing a button that would always 400.
  merchantName: string | null;
  canPause: boolean;
  priceHistory: Array<{ observedAmountMinorUnits: number; observedAmountCurrency: string; observedAt: string }>;
  cancellationSteps: CancellationSteps | null;
  evidence: Evidence | null;
}

// §40.3 Subscription state machine — `submitSubscriptionCancellation`'s own guard: cancelable from
// trial/active/trial_ended/price_changed/renewal_upcoming, never from paused/cancellation_pending/
// canceled/expired/candidate. Mirrored client-side so the button is only ever shown when the POST would
// actually succeed.
const CANCELABLE_STATES = new Set(["trial", "active", "trial_ended", "price_changed", "renewal_upcoming"]);
// `pauseSubscription`'s own guard — same active-like set as cancellation, but excluding "trial" (a trial
// isn't "paying" yet in the sense a pause option applies to).
const PAUSABLE_STATES = new Set(["active", "trial_ended", "price_changed", "renewal_upcoming"]);

/**
 * §40.3 Subscription state machine — user-initiated `active-like → cancellation_pending`. A real
 * user-facing cancellation intent even though it never calls the actual merchant (see
 * CommerceService.submitSubscriptionCancellation's own doc comment: it just marks Veynlo's own record and
 * computes the effective-until date from the subscription's own next billing date) — the confirmation copy
 * says so explicitly rather than implying this stops the charge on its own.
 */
function CancelSubscriptionAction({
  subscriptionId,
  nextChargeLabel,
  onSaved,
}: {
  subscriptionId: string;
  nextChargeLabel: string | null;
  onSaved: () => void;
}) {
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCancellation() {
    if (
      !window.confirm(
        "Mark this subscription as canceled in Veynlo? This doesn't cancel it with the merchant on its own — follow the steps below (or the merchant's site) to actually stop being charged.",
      )
    ) {
      return;
    }
    setError(null);
    setCanceling(true);
    try {
      await api.post(`/v1/subscriptions/${subscriptionId}/cancel`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't submit that cancellation.");
    } finally {
      setCanceling(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <Button size="sm" variant="critical" loading={canceling} onClick={submitCancellation}>
        Cancel subscription
      </Button>
      <p className="text-xs text-tertiary">
        This tracks your cancellation intent in Veynlo{nextChargeLabel ? ` (effective ${nextChargeLabel}, your next charge date)` : ""} — it doesn&apos;t contact{" "}
        the merchant for you. Use the steps below, or the merchant&apos;s own site, to actually stop being charged.
      </p>
      {error && <p className="text-xs text-critical">{error}</p>}
    </div>
  );
}

/**
 * SUB-004 "let a user add/correct steps for a merchant themselves" — same inline-editor pattern as
 * purchase-detail's RET-004 `PolicyEditor` (apps/web/src/app/(app)/life/purchases/[id]/page.tsx): reads the
 * currently-resolved steps on open so the form starts from the real current value (curated or already
 * corrected), not a blank slate, and posts a per-user correction that always outranks the seeded rows.
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
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-brand hover:underline">
        {current?.source === "user" ? "Edit your steps" : `Know how to cancel ${serviceLabel}?`}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-subtle p-3">
      <label className="block text-xs font-medium text-secondary" htmlFor={`cancel-steps-${merchantId}`}>
        Cancellation steps, one per line
      </label>
      <Textarea id={`cancel-steps-${merchantId}`} rows={4} value={stepsText} onChange={(e) => setStepsText(e.target.value)} placeholder={"Log into your account\nGo to Settings > Subscription\nClick Cancel Plan"} />
      <label className="block text-xs font-medium text-secondary" htmlFor={`cancel-note-${merchantId}`}>
        Where did this come from? (optional)
      </label>
      <Input id={`cancel-note-${merchantId}`} value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} placeholder="e.g. Did this myself on 2026-08-15" />
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" loading={saving} onClick={save}>
          Save steps
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * §40.3 Subscription state machine — `active-like → paused` / `paused → active`. Pause is only ever offered
 * when the server-resolved `canPause` says the merchant actually supports it (see this file's own
 * `SubscriptionDetail.canPause` doc comment) — nothing is seeded as pause-capable today, so this renders
 * nothing for any real subscription right now, honestly, rather than a button that would always fail.
 * Resume has no such gate: once a subscription genuinely reached "paused" (however it got there), undoing
 * it is always safe to offer.
 */
function PauseResumeAction({ subscriptionId, state, canPause, onSaved }: { subscriptionId: string; state: string; canPause: boolean; onSaved: () => void }) {
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
      <div className="space-y-1">
        <Button size="sm" variant="secondary" loading={working} onClick={() => run("resume")}>
          Resume subscription
        </Button>
        {error && <p className="text-xs text-critical">{error}</p>}
      </div>
    );
  }
  if (canPause && PAUSABLE_STATES.has(state)) {
    return (
      <div className="space-y-1">
        <Button size="sm" variant="secondary" loading={working} onClick={() => run("pause")}>
          Pause subscription
        </Button>
        {error && <p className="text-xs text-critical">{error}</p>}
      </div>
    );
  }
  return null;
}

export default function SubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<SubscriptionDetail | null>(`/v1/subscriptions/${id}`, swrFetcher);

  async function setEssential(essential: boolean) {
    await api.post(`/v1/subscriptions/${id}/essential`, { essential });
    mutate();
  }

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this subscription" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <EmptyState title="Not found" description="This subscription doesn't exist or you don't have access to it." />
      </div>
    );
  }

  const { subscription, stream, canPause, priceHistory, cancellationSteps, evidence } = data;
  const amount = formatMoneyMinorUnits(stream.typicalAmountMinorUnits, stream.typicalAmountCurrency);
  const trialEnds = subscription.state === "trial" ? formatTemporal(subscription.trialEndsAt) : null;
  const trialDaysLeft = subscription.state === "trial" ? daysUntil(subscription.trialEndsAt) : null;
  const nextCharge = formatTemporal(stream.nextExpectedDate);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{stream.serviceLabel}</h1>
          <p className="mt-1 text-sm capitalize text-tertiary">{stream.cadence}</p>
        </div>
        <Badge tone={STATE_TONE[subscription.state] ?? "neutral"}>{subscription.state.replace(/_/g, " ")}</Badge>
      </header>

      {/* §40.3 Subscription state machine — a submitted cancellation previously showed only as a plain
          "cancellation pending" badge, with no explanation of what that actually means or when it takes
          effect. Mirrors the trial banner just below in tone/placement. */}
      {subscription.state === "cancellation_pending" && (
        <Card>
          <CardBody className="space-y-1">
            <p className="text-sm font-medium text-primary">Cancellation submitted</p>
            <p className="text-sm text-tertiary">
              {nextCharge
                ? `This stays active until ${nextCharge}, the end of your current billing period, then moves to canceled automatically.`
                : "This will move to canceled once its current billing period ends."}
            </p>
          </CardBody>
        </Card>
      )}

      {/* SUB-002 "creates opportunity before charged renewal" — a trial previously looked identical to
          any other subscription past the state badge alone; this is the one place a user can see when
          they'll actually be charged and decide before it happens. */}
      {subscription.state === "trial" && trialEnds && (
        <Card>
          <CardBody className="space-y-1">
            <p className="text-sm font-medium text-primary">
              Trial ends {trialEnds}
              {trialDaysLeft != null && ` (${trialDaysLeft === 0 ? "today" : `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left`})`}
            </p>
            {amount && <p className="text-sm text-tertiary">You&apos;ll be charged {amount} unless you cancel first.</p>}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {amount && (
              <>
                <dt className="text-tertiary">Amount</dt>
                <dd className="text-primary">{amount}</dd>
              </>
            )}
            {/* SUB-001 "Shows ... next expected charge" — was captured (recurringStreams.nextExpectedDate)
                but never rendered anywhere. */}
            {nextCharge && subscription.state !== "trial" && (
              <>
                <dt className="text-tertiary">Next charge</dt>
                <dd className="text-primary">{nextCharge}</dd>
              </>
            )}
            <dt className="text-tertiary">Essential</dt>
            <dd className="flex items-center gap-2 text-primary">
              <span>{stream.essential == null ? "Unknown" : stream.essential ? "Yes" : "No"}</span>
              {/* §18 "mark essential/unused" — recurringStreams.essential had a real column but no writer
                  anywhere; this was always "Unknown" with no way to change it. */}
              {stream.essential !== true && (
                <Button size="sm" variant="secondary" onClick={() => setEssential(true)}>
                  Mark essential
                </Button>
              )}
              {stream.essential !== false && (
                <Button size="sm" variant="secondary" onClick={() => setEssential(false)}>
                  Mark unused
                </Button>
              )}
            </dd>
            <dt className="text-tertiary">Cancel</dt>
            <dd className="text-primary space-y-2">
              {subscription.cancellationInstructionsUrl ? (
                <a href={subscription.cancellationInstructionsUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  Cancellation instructions
                </a>
              ) : cancellationSteps ? (
                // SUB-004 "shows known steps ... when a direct API/partner flow doesn't exist" — a
                // curated (or user-corrected) reference process, since this email never stated one.
                <div className="space-y-1">
                  <ol className="list-inside list-decimal space-y-0.5 text-sm text-primary">
                    {cancellationSteps.steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                  <p className="text-xs text-tertiary">
                    {cancellationSteps.source === "user" ? "Your own correction." : "General known steps, not verified live — check the service's current process before relying on this."}
                  </p>
                  {cancellationSteps.sourceNote && <p className="text-xs italic text-tertiary">{cancellationSteps.sourceNote}</p>}
                </div>
              ) : (
                // SUB-004 "without pretending cancellation is universally automatable" — no evidenced
                // link and nothing curated for this merchant is a real, sayable answer, not an
                // empty/missing row a user might mistake for a loading state.
                <span className="text-tertiary">No cancellation link found in your emails yet, and no known steps for this service. Check the service&apos;s website or account settings directly.</span>
              )}
              {/* SUB-004 "let a user add/correct steps for a merchant themselves" — only offered when a
                  merchant was actually resolved for this stream; with no merchant there's nothing to key
                  a correction by. */}
              {stream.merchantId && (
                <CancellationStepsEditor merchantId={stream.merchantId} serviceLabel={stream.serviceLabel} current={cancellationSteps} onSaved={() => mutate()} />
              )}
            </dd>
          </dl>

          {/* §40.3 Subscription state machine — real UI triggers for submitSubscriptionCancellation/
              pauseSubscription/resumeSubscription, found live via QA to have no button anywhere despite
              full backend support. */}
          <div className="flex flex-wrap items-start gap-3 border-t border-border-subtle pt-3">
            {CANCELABLE_STATES.has(subscription.state) && (
              <CancelSubscriptionAction subscriptionId={String(id)} nextChargeLabel={nextCharge} onSaved={() => mutate()} />
            )}
            <PauseResumeAction subscriptionId={String(id)} state={subscription.state} canPause={canPause} onSaved={() => mutate()} />
          </div>
        </CardBody>
      </Card>

      {/* SUB-001 "Shows ... price history" — extractSubscription's price-change branch already logs
          every detected change to price_observations; this is the first place it's ever surfaced. */}
      {priceHistory.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Price history</p>
            <ul className="space-y-1 text-sm">
              {priceHistory.map((p, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="text-tertiary">{formatTemporal({ precision: "instant", instantUtc: p.observedAt, date: null, timezone: null, sourceText: null })}</span>
                  <span className="text-primary">{formatMoneyMinorUnits(p.observedAmountMinorUnits, p.observedAmountCurrency)}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
