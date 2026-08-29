"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input, Label, FieldError, Textarea } from "@/components/ui/input";

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  autoFiled: boolean;
  suggestedActions: string[];
  linkedResourceType: string | null;
}

interface SourceInspection {
  kind: string;
  subjectLine: string | null;
  snippet: string | null;
  fromAddress: string | null;
  occurredAt: string;
}

type FilterTab = "needs_review" | "auto_filed" | "low_confidence" | "all";

const FILTER_TABS: Array<{ value: FilterTab; label: string }> = [
  { value: "needs_review", label: "Needs Review" },
  { value: "auto_filed", label: "Auto-filed" },
  { value: "low_confidence", label: "Low Confidence" },
  { value: "all", label: "All" },
];

const CATEGORIES = ["purchase", "shipment", "bill", "subscription", "appointment", "warranty", "task"];

function queryFor(filter: FilterTab, category: string): string {
  const params = new URLSearchParams();
  if (filter === "needs_review") params.set("reviewState", "new");
  if (filter === "auto_filed") params.set("autoFiled", "true");
  if (filter === "low_confidence") params.set("confidenceBand", "needs_review");
  if (category) params.set("category", category);
  const qs = params.toString();
  return qs ? `/v1/inbox?${qs}` : "/v1/inbox";
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
  const [filter, setFilter] = useState<FilterTab>("needs_review");
  const [category, setCategory] = useState("");
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteMessage, setPasteMessage] = useState<string | null>(null);
  const { data, isLoading, mutate } = useSWR<InboxItem[]>(queryFor(filter, category), swrFetcher);

  /** §CAP-008 "Clipboard Quick Capture" — a one-tap capture of whatever's already on the clipboard, without
   * opening the manual-add form and pasting it in by hand. Reuses the same manual/url ingestion endpoints
   * CaptureForm's "Paste text"/"From a URL" modes use — this is just a faster path into the same pipeline. */
  async function quickPasteCapture() {
    setPasting(true);
    setPasteMessage(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setPasteMessage("Your clipboard is empty.");
        return;
      }
      const isUrl = /^https?:\/\/\S+$/i.test(text.trim());
      if (isUrl) {
        await api.post("/v1/ingestion/url", { url: text.trim() });
      } else {
        const firstLine = text.trim().split("\n")[0]?.slice(0, 500) || "Pasted note";
        await api.post("/v1/ingestion/manual", { subject: firstLine, bodyText: text });
      }
      setPasteMessage("Captured from clipboard.");
      mutate();
    } catch {
      setPasteMessage("Couldn't read your clipboard. Your browser may be blocking clipboard access.");
    } finally {
      setPasting(false);
    }
  }

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    mutate();
  }

  async function snooze(id: string) {
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await api.post(`/v1/inbox/${id}/snooze`, { until });
    mutate();
  }

  async function blockSender(id: string) {
    await api.post(`/v1/inbox/${id}/block-sender`);
    mutate();
  }

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-primary">Inbox</h1>
            <p className="mt-1 text-sm text-tertiary">Newly discovered information to review.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={quickPasteCapture} loading={pasting}>
              Paste from clipboard
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setCapturing((v) => !v)}>
              {capturing ? "Cancel" : "Add manually"}
            </Button>
          </div>
        </div>
        {pasteMessage && <p className="text-sm text-tertiary">{pasteMessage}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-subtle p-1">
            {FILTER_TABS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  filter === f.value ? "bg-surface text-primary shadow-xs" : "text-tertiary"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg border border-border-default bg-surface px-2.5 py-1.5 text-sm text-primary"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
      </header>

      {capturing && (
        <CaptureForm
          onDone={() => {
            setCapturing(false);
            mutate();
          }}
          onCancel={() => setCapturing(false)}
        />
      )}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && data?.length === 0 && (
        <EmptyState
          title="You're caught up."
          description="New receipts, bills, appointments, and other discoveries will show up here for a quick review before they're filed."
        />
      )}

      {!isLoading && data && data.length > 0 && (
        <ul className="space-y-3">
          {data.map((item) => {
            const fields = item.linkedResourceType ? CORRECTION_FIELDS[item.linkedResourceType] : undefined;
            return (
              <li key={item.id}>
                <Card>
                  <CardBody className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Badge tone="neutral">{item.category}</Badge>
                          <Badge tone={CONFIDENCE_TONE[item.confidenceBand] ?? "neutral"}>
                            {item.confidenceBand.replace("_", " ")}
                          </Badge>
                          {item.autoFiled && <Badge tone="neutral">auto-filed</Badge>}
                        </div>
                        <p className="text-[0.9375rem] font-medium text-primary">{item.summary}</p>
                      </div>
                    </div>
                    {item.reviewState === "new" && correctingId !== item.id && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" onClick={() => act(item.id, "confirm")}>
                          Confirm
                        </Button>
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
                        <Button size="sm" variant="ghost" onClick={() => setInspectingId(inspectingId === item.id ? null : item.id)}>
                          Inspect source
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => blockSender(item.id)}>
                          Block sender
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
                    {inspectingId === item.id && <SourceInspectionPanel itemId={item.id} />}
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ul>
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
    </form>
  );
}

/** INB-001 "inspect source" — the bounded fields source_events actually stores (never a full body, see the schema comment); "why am I seeing this?" not a durable copy of the original message. */
function SourceInspectionPanel({ itemId }: { itemId: string }) {
  const { data, error } = useSWR<SourceInspection>(`/v1/inbox/${itemId}/source`, swrFetcher);

  return (
    <div className="space-y-1.5 rounded-lg border border-border-subtle bg-subtle p-3 text-sm">
      {error && <p className="text-tertiary">The original source is no longer available.</p>}
      {!error && !data && <p className="text-tertiary">Loading…</p>}
      {data && (
        <>
          <p className="text-tertiary">
            <span className="font-medium text-primary">From:</span> {data.fromAddress ?? "Unknown"}
          </p>
          {data.subjectLine && (
            <p className="text-tertiary">
              <span className="font-medium text-primary">Subject:</span> {data.subjectLine}
            </p>
          )}
          {data.snippet && <p className="text-tertiary">{data.snippet}</p>}
          <p className="text-xs text-tertiary">Received {new Date(data.occurredAt).toLocaleString()}</p>
        </>
      )}
    </div>
  );
}
