"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input, Label, FieldError, Textarea } from "@/components/ui/input";
import { REMINDER_OPTIONS, PROVIDER_LABEL as CALENDAR_PROVIDER_LABEL } from "@/lib/calendar-destinations";

// RET-004 "Policy engine ... deadline calculator" — only present on category "price_adjustment" items
// (see InboxService.list's own doc comment), resolved from the linked purchase's merchant policy. Same
// shape as the purchase-detail page's PriceAdjustmentPolicy so a user sees one consistent deadline/
// confidence, whether they act from the Inbox or from the purchase itself.
interface InboxPriceAdjustment {
  deadline: string;
  daysLeft: number;
  windowDays: number;
  policyConfidence: "user_confirmed" | "commonly_known" | "assumed";
  policySourceNote: string | null;
}

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  suggestedActions: string[];
  linkedResourceType: string | null;
  linkedResourceId: string | null;
  snoozedUntil: string | null;
  autoFiled: boolean;
  priceAdjustment?: InboxPriceAdjustment;
}

const POLICY_CONFIDENCE_LABEL: Record<InboxPriceAdjustment["policyConfidence"], string> = {
  user_confirmed: "You confirmed this policy",
  commonly_known: "Publicly documented policy",
  assumed: "Unconfirmed — using Veynlo's default",
};
const POLICY_CONFIDENCE_TONE: Record<InboxPriceAdjustment["policyConfidence"], "positive" | "info" | "neutral"> = {
  user_confirmed: "positive",
  commonly_known: "info",
  assumed: "neutral",
};

// §INB-001 "Filters include Needs Review, Auto-filed, Duplicates, Low Confidence, and category" — the
// review-state New/All toggle already covered "Needs Review", and `/v1/inbox?category=` already existed
// server-side, but nothing on this page ever surfaced autoFiled or confidenceBand as filterable, and there
// was no category picker at all — found live via a real audit (the API returned `autoFiled` on every item;
// the page's own InboxItem type didn't even declare the field). "Duplicates" is deliberately left out: the
// schema has no dedup/duplicate-detection concept anywhere (no linking field between candidate duplicate
// items), so a real "Duplicates" filter needs that detection logic built first, not just a UI toggle.
const LOW_CONFIDENCE_BANDS = new Set(["needs_review", "approximate", "conflicting"]);

const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

// The "All" filter (unlike "New") includes items in every reviewState — without a visible label, a
// confirmed, dismissed, archived, and snoozed item all rendered as identical, unlabeled cards (found live:
// nothing distinguished a dismissed item from an active one once you left the "New" tab).
const REVIEW_STATE_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  archived: "Archived",
  deleted: "Dismissed",
  snoozed: "Snoozed",
};

const REVIEW_STATE_TONE: Record<string, "positive" | "neutral" | "warning"> = {
  confirmed: "positive",
  archived: "neutral",
  deleted: "neutral",
  snoozed: "warning",
};

interface CorrectionField {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "datetime-local";
}

// One entry per linkedResourceType InboxService.correct() knows how to handle — keep in sync with
// services/api/src/modules/attention/dto.ts's CorrectInboxItemDtoSchema.
const CORRECTION_FIELDS: Record<string, CorrectionField[]> = {
  purchase: [
    { key: "orderNumber", label: "Order number", type: "text" },
    { key: "totalMinorUnits", label: "Total (in cents)", type: "number" },
    { key: "totalCurrency", label: "Currency (e.g. USD)", type: "text" },
    { key: "purchaseDateIso", label: "Purchase date", type: "date" },
  ],
  bill: [
    { key: "billerLabel", label: "Biller name", type: "text" },
    { key: "amountDueMinorUnits", label: "Amount due (in cents)", type: "number" },
    { key: "amountDueCurrency", label: "Currency (e.g. USD)", type: "text" },
    { key: "dueDateIso", label: "Due date", type: "date" },
  ],
  calendar_event: [
    { key: "title", label: "Title", type: "text" },
    { key: "location", label: "Location", type: "text" },
    { key: "startIso", label: "Start time", type: "datetime-local" },
  ],
  shipment: [
    { key: "carrier", label: "Carrier", type: "text" },
    { key: "trackingNumber", label: "Tracking number", type: "text" },
    { key: "status", label: "Status", type: "text" },
  ],
  warranty: [
    { key: "productLabel", label: "Product", type: "text" },
    { key: "warrantyLengthMonths", label: "Warranty length (months)", type: "number" },
    { key: "expirationDateIso", label: "Expiration date", type: "date" },
  ],
  subscription: [
    { key: "serviceLabel", label: "Service name", type: "text" },
    { key: "typicalAmountMinorUnits", label: "Amount (in cents)", type: "number" },
    { key: "typicalAmountCurrency", label: "Currency (e.g. USD)", type: "text" },
  ],
};

export default function InboxPage() {
  const t = useTranslations("inbox");
  const [filter, setFilter] = useState<"new" | "all">("new");
  // §INB-001 "Filters include ... Auto-filed ... Low Confidence, and category" — client-side on top of the
  // existing reviewState fetch, since both are yes/no properties of items already on the page rather than
  // a separate query.
  const [quickFilter, setQuickFilter] = useState<"none" | "auto_filed" | "low_confidence">("none");
  const [category, setCategory] = useState<string>("all");
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [addingToCalendarId, setAddingToCalendarId] = useState<string | null>(null);
  // CAL-004 "offer, don't auto-apply" — the review step for an offered reschedule (`["apply_change",
  // "dismiss"]` suggestedActions — see InboxService.applyRescheduleChange).
  const [applyingRescheduleId, setApplyingRescheduleId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const { data, error, isLoading, mutate } = useSWR<InboxItem[]>(
    filter === "new" ? "/v1/inbox?reviewState=new" : "/v1/inbox",
    swrFetcher,
  );
  // CAL-002 "offers Add to calendar with chosen destination" — the destinations a discovered event can be
  // pushed to (write-back-enabled Google/Microsoft Calendar connections); fetched once for the whole page
  // rather than per-item, same as CORRECTION_FIELDS is a static lookup rather than a per-item fetch.
  const { data: connections } = useSWR<{ id: string; provider: string; writeBackEnabled: boolean }[]>("/v1/connectors", swrFetcher);
  const calendarDestinations = (connections ?? []).filter(
    (c) => (c.provider === "google_calendar" || c.provider === "microsoft_calendar") && c.writeBackEnabled,
  );

  const categories = Array.from(new Set((data ?? []).map((i) => i.category))).sort();
  const visibleData = (data ?? []).filter((i) => {
    if (category !== "all" && i.category !== category) return false;
    if (quickFilter === "auto_filed" && !i.autoFiled) return false;
    if (quickFilter === "low_confidence" && !LOW_CONFIDENCE_BANDS.has(i.confidenceBand)) return false;
    return true;
  });
  // Phase 2 §52.2 "bulk management" — spec §37.1's own example: "12 receipts found... one rule-level
  // question instead of 12 repetitive confirmations." Confirm/dismiss are both reversible review actions
  // (§AI-001 promotion / a soft reviewState, not a destructive delete), so no extra confirm step is needed
  // beyond selecting and clicking, unlike Documents' bulk delete.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  // INB-002 "Batch API validates each underlying authorization/version and returns partial successes with
  // per-item error details" — found live via a real audit: the API already returned {succeeded, failed}
  // (a batch never throws just because one item failed), but this page discarded that response entirely,
  // so a partial failure looked identical to full success — the user saw their selection clear with no
  // indication anything didn't go through. A failed id here only ever means "not found or not yours"
  // (InboxService.assertOwned's only two failure modes), so the copy below doesn't promise a retry will
  // help; the ids stay selected only so a failed item that's still visible highlights as such.
  const [bulkResultNote, setBulkResultNote] = useState<string | null>(null);

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const reviewable = visibleData.filter((i) => i.reviewState === "new");
    setSelectedIds((prev) => (prev.size === reviewable.length ? new Set() : new Set(reviewable.map((i) => i.id))));
  }

  async function bulkAct(action: "confirm" | "dismiss") {
    setBulkActing(true);
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
      mutate();
    } finally {
      setBulkActing(false);
    }
  }

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    mutate();
  }

  // CAL-003 "email-vs-calendar date disagreement" — the user's own pick between the two dates a
  // `["use_email_date", "keep_calendar_date", "dismiss"]` item offers (see
  // InboxService.resolveDateDisagreement). "dismiss" reuses the generic action above; only these two extra
  // choices need their own handler.
  async function resolveDateDisagreement(id: string, choice: "use_email_date" | "keep_calendar_date") {
    await api.post(`/v1/inbox/${id}/resolve-date-disagreement`, { choice });
    mutate();
  }

  async function snooze(id: string) {
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await api.post(`/v1/inbox/${id}/snooze`, { until });
    mutate();
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{t("title")}</h1>
          <p className="mt-1 text-sm text-tertiary">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-subtle p-1">
            {(["new", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                  filter === f ? "bg-surface text-primary shadow-xs" : "text-tertiary"
                }`}
              >
                {f === "new" ? t("filterNew") : t("filterAll")}
              </button>
            ))}
          </div>
          <Button size="sm" variant="secondary" onClick={() => setCapturing((v) => !v)}>
            {capturing ? t("cancel") : t("addManually")}
          </Button>
        </div>
      </header>

      {!isLoading && data && data.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              ["none", t("quickFilterAll")],
              ["auto_filed", t("quickFilterAutoFiled")],
              ["low_confidence", t("quickFilterLowConfidence")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setQuickFilter(value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                quickFilter === value
                  ? "border-brand bg-brand-subtle text-brand-subtle-text"
                  : "border-border-default text-tertiary hover:bg-subtle"
              }`}
            >
              {label}
            </button>
          ))}
          {categories.length > 1 && (
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-full border border-border-default bg-surface px-3 py-1 text-xs font-medium capitalize text-secondary"
              aria-label={t("filterByCategory")}
            >
              <option value="all">{t("allCategories")}</option>
              {categories.map((c) => (
                <option key={c} value={c} className="capitalize">
                  {c.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {capturing && (
        <CaptureForm
          onDone={() => {
            setCapturing(false);
            mutate();
          }}
          onCancel={() => setCapturing(false)}
        />
      )}

      {/* Deliberately outside every branch below (isLoading/empty/no-match/populated) — found live via this
          audit's own repro: a bulk action that resolves the LAST "new" item(s) with one genuine per-item
          failure mixed in flips this screen straight to the "You're caught up." empty state on the very
          same render the partial-failure note was meant to explain, and a note nested inside the
          "has items" branch below would have disappeared at exactly the moment it mattered most. */}
      {bulkResultNote && (
        <div className="rounded-lg border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {bulkResultNote}
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && error && !data && (
        <FetchError what="your inbox" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !error && data?.length === 0 && <EmptyState title={t("caughtUpTitle")} description={t("caughtUpDescription")} />}

      {!isLoading && data && data.length > 0 && visibleData.length === 0 && (
        <EmptyState title={t("noMatchTitle")} description={t("noMatchDescription")} />
      )}

      {!isLoading && data && data.length > 0 && visibleData.length > 0 && (
        <>
          {visibleData.some((i) => i.reviewState === "new") && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border-subtle bg-subtle px-3 py-2">
              <label className="flex items-center gap-2 text-sm text-secondary">
                <input
                  type="checkbox"
                  checked={selectedIds.size > 0 && selectedIds.size === visibleData.filter((i) => i.reviewState === "new").length}
                  onChange={toggleSelectAll}
                />
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}
              </label>
              {selectedIds.size > 0 && (
                <div className="flex gap-2">
                  <Button size="sm" loading={bulkActing} onClick={() => bulkAct("confirm")}>
                    Confirm selected
                  </Button>
                  <Button size="sm" variant="ghost" loading={bulkActing} onClick={() => bulkAct("dismiss")}>
                    Dismiss selected
                  </Button>
                </div>
              )}
            </div>
          )}
          <ul className="space-y-3">
          {visibleData.map((item) => {
            const fields = item.linkedResourceType ? CORRECTION_FIELDS[item.linkedResourceType] : undefined;
            return (
              <li key={item.id}>
                <Card>
                  <CardBody className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        {item.reviewState === "new" && (
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={selectedIds.has(item.id)}
                            onChange={() => toggleSelected(item.id)}
                            aria-label={`Select ${item.summary}`}
                          />
                        )}
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2">
                            <Badge tone="neutral">{item.category}</Badge>
                            <Badge tone={CONFIDENCE_TONE[item.confidenceBand] ?? "neutral"}>
                              {item.confidenceBand.replace("_", " ")}
                            </Badge>
                            {/* §INB-001 "whether the system has already auto-filed it" — the API returns
                                autoFiled on every item but no card ever rendered it, so an auto-filed item
                                looked identical to one still awaiting a first pass. */}
                            {item.autoFiled && <Badge tone="info">Auto-filed</Badge>}
                            {item.reviewState !== "new" && (
                              <Badge tone={REVIEW_STATE_TONE[item.reviewState] ?? "neutral"}>
                                {REVIEW_STATE_LABEL[item.reviewState] ?? item.reviewState}
                                {item.reviewState === "snoozed" && item.snoozedUntil
                                  ? ` until ${new Date(item.snoozedUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                                  : ""}
                              </Badge>
                            )}
                          </div>
                          <p className="text-[0.9375rem] font-medium text-primary">{item.summary}</p>
                          {/* RET-004 "deadline calculator" + "policy confidence" — the price_adjustment
                              summary text above only ever stated the price drop, never a deadline; this is
                              the same structured field the purchase-detail banner shows. */}
                          {item.priceAdjustment && (
                            <div className="flex flex-wrap items-center gap-2 text-xs text-tertiary">
                              <Badge tone={POLICY_CONFIDENCE_TONE[item.priceAdjustment.policyConfidence]}>
                                {POLICY_CONFIDENCE_LABEL[item.priceAdjustment.policyConfidence]}
                              </Badge>
                              <span className="font-medium text-primary">
                                {item.priceAdjustment.daysLeft > 0
                                  ? `${item.priceAdjustment.daysLeft} day${item.priceAdjustment.daysLeft === 1 ? "" : "s"} left to request a price adjustment`
                                  : item.priceAdjustment.daysLeft === 0
                                    ? "Last day to request a price adjustment"
                                    : "Price-adjustment window likely passed"}
                              </span>
                              <span>
                                (deadline {new Date(item.priceAdjustment.deadline).toLocaleDateString()}, {item.priceAdjustment.windowDays}-day window)
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    {item.reviewState === "new" && correctingId !== item.id && addingToCalendarId !== item.id && applyingRescheduleId !== item.id && (
                      <div className="flex flex-wrap gap-2">
                        {!item.suggestedActions.includes("apply_change") && (
                          <Button size="sm" onClick={() => act(item.id, "confirm")}>
                            Confirm
                          </Button>
                        )}
                        {item.linkedResourceType === "calendar_event" && !item.suggestedActions.includes("apply_change") && (
                          <Button size="sm" variant="secondary" onClick={() => setAddingToCalendarId(item.id)}>
                            Add to calendar
                          </Button>
                        )}
                        {item.suggestedActions.includes("apply_change") && (
                          <Button size="sm" onClick={() => setApplyingRescheduleId(item.id)}>
                            Review change
                          </Button>
                        )}
                        {item.suggestedActions.includes("use_email_date") && (
                          <Button size="sm" onClick={() => resolveDateDisagreement(item.id, "use_email_date")}>
                            Use email date
                          </Button>
                        )}
                        {item.suggestedActions.includes("keep_calendar_date") && (
                          <Button size="sm" variant="secondary" onClick={() => resolveDateDisagreement(item.id, "keep_calendar_date")}>
                            Keep calendar date
                          </Button>
                        )}
                        {fields && (
                          <Button size="sm" variant="secondary" onClick={() => setCorrectingId(item.id)}>
                            Correct
                          </Button>
                        )}
                        <Button size="sm" variant="secondary" onClick={() => snooze(item.id)}>
                          Snooze 1 week
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => act(item.id, "archive")}>
                          Archive
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => act(item.id, "dismiss")}>
                          Dismiss
                        </Button>
                      </div>
                    )}
                    {item.reviewState === "new" && correctingId === item.id && fields && (
                      <CorrectionForm
                        itemId={item.id}
                        fields={fields}
                        onDone={() => {
                          setCorrectingId(null);
                          mutate();
                        }}
                        onCancel={() => setCorrectingId(null)}
                      />
                    )}
                    {item.reviewState === "new" && addingToCalendarId === item.id && (
                      <AddToCalendarForm
                        itemId={item.id}
                        destinations={calendarDestinations}
                        onDone={() => {
                          setAddingToCalendarId(null);
                          mutate();
                        }}
                        onCancel={() => setAddingToCalendarId(null)}
                      />
                    )}
                    {item.reviewState === "new" && applyingRescheduleId === item.id && (
                      <ApplyRescheduleForm
                        itemId={item.id}
                        onDone={() => {
                          setApplyingRescheduleId(null);
                          mutate();
                        }}
                        onCancel={() => setApplyingRescheduleId(null)}
                      />
                    )}
                  </CardBody>
                </Card>
              </li>
            );
          })}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * §CAP-005/006 forward + quick-text capture — pastes a receipt/bill/confirmation email's text (or any
 * plain description) through the same pipeline a real connected inbox uses. Submitting always succeeds;
 * whether it produces a new Inbox item depends on what Veynlo's extraction actually finds in the text
 * (nothing configured in this environment means it's filed with no card — same as a genuinely irrelevant
 * email would be), so the confirmation is deliberately non-committal about what happens next.
 */
function CaptureForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [mode, setMode] = useState<"text" | "url">("text");
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // This form's `required` attributes are decorative only — the <form> is `noValidate` (same reason
    // every form on this page is: real per-field errors come back from the server, not the browser's own
    // validation bubble), so nothing here ever stopped an empty submit before this fix. Found live: an
    // empty "From a URL" submit sailed straight through to the API and came back with the backend's
    // generic VALIDATION_FAILED body (see zod-validation.pipe.ts), which this form has no fieldErrors
    // handling for at all (unlike CorrectionForm's own error state, this one only ever renders a single
    // generic `error` string) — so the user saw the raw, technical "Request body failed validation."
    // instead of anything explaining what was actually missing.
    if (mode === "url" && !url.trim()) {
      setError("Enter a URL.");
      return;
    }
    if (mode === "text" && (!subject.trim() || !bodyText.trim())) {
      setError("Enter a subject and content.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "url") {
        await api.post("/v1/ingestion/url", { url });
        setUrl("");
      } else {
        await api.post("/v1/ingestion/manual", {
          subject,
          bodyText,
          fromAddress: fromAddress || undefined,
        });
        setSubject("");
        setFromAddress("");
        setBodyText("");
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <Card>
        <CardBody className="space-y-3">
          <p className="text-[0.9375rem] text-primary">
            Submitted. If Veynlo finds something worth reviewing in it, a card will appear here shortly.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setDone(false)}>
              Add another
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Done
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <div className="flex gap-1 rounded-lg bg-subtle p-1" role="tablist">
            {(["text", "url"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === m ? "bg-surface text-primary shadow-xs" : "text-tertiary"
                }`}
              >
                {m === "text" ? "Paste text" : "From a URL"}
              </button>
            ))}
          </div>

          {mode === "text" ? (
            <>
              <p className="text-sm text-tertiary">
                Paste the text of a receipt, bill, confirmation, or other email — or just describe what happened.
              </p>
              <div>
                <Label htmlFor="capture-subject">Subject</Label>
                <Input id="capture-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={500} />
              </div>
              <div>
                <Label htmlFor="capture-from">From (optional)</Label>
                <Input
                  id="capture-from"
                  type="email"
                  value={fromAddress}
                  onChange={(e) => setFromAddress(e.target.value)}
                  placeholder="billing@example.com"
                />
              </div>
              <div>
                <Label htmlFor="capture-body">Content</Label>
                <Textarea
                  id="capture-body"
                  rows={8}
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  required
                  maxLength={50_000}
                />
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-tertiary">
                Paste a link to a confirmation page, event listing, or anything else worth remembering — Veynlo will
                read the page and pull out what it can.
              </p>
              <div>
                <Label htmlFor="capture-url">URL</Label>
                <Input
                  id="capture-url"
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/order/12345"
                  required
                />
              </div>
            </>
          )}

          <FieldError>{error ?? undefined}</FieldError>
          <div className="flex gap-2">
            <Button type="submit" size="sm" loading={submitting}>
              Submit
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

const SENDER_RULE_ACTION_LABEL: Record<string, string> = {
  always_school: "School",
  always_bills: "Bills",
  ignore: "Ignore",
  attachments_only: "Keep only attachments",
  household_shared: "Household shared",
};

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
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // MAIL-006 "From Inbox: Always treat messages from this sender as..." — a small, separate action from
  // the field-correction form above (it doesn't touch this item's own extracted fields at all, it teaches
  // Veynlo about the SENDER going forward), but placed right here since a misclassified item is exactly
  // when a user notices they want this. See InboxService.addSenderRuleFromInboxItem.
  const [senderRuleAction, setSenderRuleAction] = useState("");
  const [applyingSenderRule, setApplyingSenderRule] = useState(false);
  const [senderRuleError, setSenderRuleError] = useState<string | null>(null);
  const [senderRuleDone, setSenderRuleDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const patch: Record<string, string | number> = {};
      for (const field of fields) {
        const raw = values[field.key];
        if (!raw) continue; // blank means "leave unchanged" — only send fields the user actually filled in
        if (field.type === "number") patch[field.key] = Number(raw);
        else if (field.type === "datetime-local") patch[field.key] = new Date(raw).toISOString();
        else patch[field.key] = raw;
      }
      if (Object.keys(patch).length === 0) {
        setError("Enter at least one corrected value, or Cancel.");
        setSubmitting(false);
        return;
      }
      await api.post(`/v1/inbox/${itemId}/correct`, patch);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
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
      setSenderRuleError(err instanceof ApiError ? err.message : "Couldn't create that rule. Please try again.");
    } finally {
      setApplyingSenderRule(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-border-subtle bg-subtle p-3" noValidate>
      <p className="text-sm text-tertiary">Only fill in the fields that are wrong — everything else stays as extracted.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => (
          <div key={field.key}>
            <Label htmlFor={`${itemId}-${field.key}`}>{field.label}</Label>
            <Input
              id={`${itemId}-${field.key}`}
              type={field.type}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <FieldError>{error ?? undefined}</FieldError>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting}>
          Save correction
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
        <Label htmlFor={`${itemId}-sender-rule`}>Always treat mail from this sender as</Label>
        <select
          id={`${itemId}-sender-rule`}
          value={senderRuleAction}
          onChange={(e) => setSenderRuleAction(e.target.value)}
          className="h-9 rounded-lg border border-border-subtle bg-surface px-3 text-sm text-primary"
        >
          <option value="">Choose…</option>
          {Object.entries(SENDER_RULE_ACTION_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <Button type="button" size="sm" variant="secondary" disabled={!senderRuleAction} loading={applyingSenderRule} onClick={applySenderRule}>
          Apply
        </Button>
        {senderRuleDone && <span className="text-sm text-tertiary">Saved — see Settings → Sender rules.</span>}
        <FieldError>{senderRuleError ?? undefined}</FieldError>
      </div>
    </form>
  );
}

/**
 * CAL-002 "offers Add to calendar with chosen destination and reminder defaults" — a discovered event
 * already exists in `calendar_events` the moment it's discovered (see IngestionService.extractCalendarEvent),
 * so "destination" here means: leave it as a Life-Inbox-only event, or also push it to one of the user's
 * write-back-enabled connected calendars (InboxService.addToCalendar). Reminder lead time defaults to
 * whatever the event already has (60/1440 minutes — see defaultReminderMinutes) but can be changed here too.
 */
function AddToCalendarForm({
  itemId,
  destinations,
  onDone,
  onCancel,
}: {
  itemId: string;
  destinations: { id: string; provider: string }[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [destinationConnectionId, setDestinationConnectionId] = useState<string>("");
  const [reminderMinutesBefore, setReminderMinutesBefore] = useState<number>(60);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/inbox/${itemId}/add-to-calendar`, {
        destinationConnectionId: destinationConnectionId || null,
        reminderMinutesBefore,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-border-subtle bg-subtle p-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={`${itemId}-destination`}>Destination</Label>
          <select
            id={`${itemId}-destination`}
            value={destinationConnectionId}
            onChange={(e) => setDestinationConnectionId(e.target.value)}
            className="h-9 w-full rounded-lg border border-border-subtle bg-surface px-3 text-sm text-primary"
          >
            <option value="">Life Inbox only</option>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {CALENDAR_PROVIDER_LABEL[d.provider] ?? d.provider}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`${itemId}-reminder`}>Remind me</Label>
          <select
            id={`${itemId}-reminder`}
            value={reminderMinutesBefore}
            onChange={(e) => setReminderMinutesBefore(Number(e.target.value))}
            className="h-9 w-full rounded-lg border border-border-subtle bg-surface px-3 text-sm text-primary"
          >
            {REMINDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {destinations.length === 0 && (
        <p className="text-sm text-tertiary">
          No connected calendars have write-back turned on yet — this event stays in Life Inbox only. Turn on write-back for a
          connection on the Connections page to push events there too.
        </p>
      )}
      <FieldError>{error ?? undefined}</FieldError>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting}>
          Confirm
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — the review step
 * behind an offered reschedule's "Review change" button. `trustSender` is the "Always trust reschedule
 * emails like this one" opt-in, reachable right here — the natural place a user would opt in, at the
 * moment they see the first legitimate reschedule from a given sender (see InboxService.
 * applyRescheduleChange for what it does: inserts a calendarRescheduleTrustedRules row so the NEXT
 * reschedule from this sender auto-applies instead of being offered again).
 */
function ApplyRescheduleForm({ itemId, onDone, onCancel }: { itemId: string; onDone: () => void; onCancel: () => void }) {
  const [trustSender, setTrustSender] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/inbox/${itemId}/apply-reschedule`, { trustSender });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-border-subtle bg-subtle p-3" noValidate>
      <label className="flex items-center gap-2 text-sm text-secondary">
        <input
          type="checkbox"
          checked={trustSender}
          onChange={(e) => setTrustSender(e.target.checked)}
          className="size-4 rounded border-border-default"
        />
        Always trust reschedule emails like this one
      </label>
      <FieldError>{error ?? undefined}</FieldError>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting}>
          Apply change
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
