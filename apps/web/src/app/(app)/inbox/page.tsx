"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input, Label, FieldError, Textarea } from "@/components/ui/input";
import { DropdownMenu } from "@/components/ui/dropdown-menu";

// Web Speech API isn't in the standard lib.dom types and is Chrome/Edge-only (no Safari support as of
// this writing) — feature-detected at runtime, never assumed present. Same shape as the Ask page's
// identical helper (duplicated rather than shared — each page here is self-contained).
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function getSpeechRecognition(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null;
}

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

type FilterTab = "needs_review" | "auto_filed" | "low_confidence" | "duplicates" | "all";

const FILTER_TABS: Array<{ value: FilterTab; label: string }> = [
  { value: "needs_review", label: "Needs Review" },
  { value: "auto_filed", label: "Auto-filed" },
  { value: "low_confidence", label: "Low Confidence" },
  { value: "duplicates", label: "Duplicates" },
  { value: "all", label: "All" },
];

const CATEGORIES = ["purchase", "shipment", "bill", "subscription", "appointment", "warranty", "task"];

function queryFor(filter: FilterTab, category: string, before?: string | null): string {
  const params = new URLSearchParams();
  if (filter === "needs_review") params.set("reviewState", "new");
  if (filter === "auto_filed") params.set("autoFiled", "true");
  // "approximate" is the actual lowest confidence band (verified > needs_review > approximate) — this
  // previously queried "needs_review" itself, showing the middle band and leaving the real low-confidence
  // items (and the "Low Confidence" tab's own purpose) unreachable via any filter.
  if (filter === "low_confidence") params.set("confidenceBand", "approximate");
  if (filter === "duplicates") params.set("isDuplicate", "true");
  if (category) params.set("category", category);
  if (before) params.set("before", before);
  const qs = params.toString();
  return qs ? `/v1/inbox?${qs}` : "/v1/inbox";
}

interface InboxPage {
  items: InboxItem[];
  nextCursor: string | null;
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
  const [rulePickerId, setRulePickerId] = useState<string | null>(null);
  const [ruleCategory, setRuleCategory] = useState(CATEGORIES[0]);
  const [capturing, setCapturing] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [pasteMessage, setPasteMessage] = useState<string | null>(null);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // Backend-robustness fix — GET /v1/inbox is now cursor-paginated rather than returning every matching
  // row unbounded. `refresh` re-fetches page one (used on filter/category change and after any mutation,
  // same semantics as the SWR `mutate()` this replaces); `loadMore` appends the next page.
  const refresh = useCallback(() => {
    setIsLoading(true);
    api
      .get<InboxPage>(queryFor(filter, category))
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .finally(() => setIsLoading(false));
  }, [filter, category]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<InboxPage>(queryFor(filter, category, cursor));
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

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
      refresh();
    } catch {
      setPasteMessage("Couldn't read your clipboard. Your browser may be blocking clipboard access.");
    } finally {
      setPasting(false);
    }
  }

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    refresh();
  }

  async function snooze(id: string) {
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await api.post(`/v1/inbox/${id}/snooze`, { until });
    refresh();
  }

  async function blockSender(id: string) {
    await api.post(`/v1/inbox/${id}/block-sender`);
    refresh();
  }

  /** MAIL-006 "always treat messages from this sender as X" — the backend (`POST /v1/inbox/:id/sender-rule`)
   * already existed with no UI anywhere calling it; this is that missing control. */
  async function createSenderRule(id: string) {
    await api.post(`/v1/inbox/${id}/sender-rule`, { category: ruleCategory });
    setRulePickerId(null);
    refresh();
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
          <div className="max-w-full overflow-x-auto">
            <div className="flex w-max gap-1 rounded-lg bg-subtle p-1">
              {FILTER_TABS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setFilter(f.value)}
                  className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    filter === f.value ? "bg-surface text-primary shadow-xs" : "text-tertiary"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
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
            refresh();
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

      {!isLoading && items.length === 0 && (
        <EmptyState
          title="You're caught up."
          description="New receipts, bills, appointments, and other discoveries will show up here for a quick review before they're filed."
        />
      )}

      {!isLoading && items.length > 0 && (
        <ul className="space-y-3">
          {items.map((item) => {
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
                      <div className="flex flex-wrap items-center gap-2">
                        <Button size="sm" onClick={() => act(item.id, "confirm")}>
                          Confirm
                        </Button>
                        {fields && (
                          <Button size="sm" variant="secondary" onClick={() => setCorrectingId(item.id)}>
                            Correct
                          </Button>
                        )}
                        <DropdownMenu
                          items={[
                            { label: "Snooze 1 week", onSelect: () => snooze(item.id) },
                            { label: "Archive", onSelect: () => act(item.id, "archive") },
                            { label: "Dismiss", onSelect: () => act(item.id, "dismiss") },
                            { label: "Inspect source", onSelect: () => setInspectingId(inspectingId === item.id ? null : item.id) },
                            { label: "Block sender", onSelect: () => blockSender(item.id), tone: "critical" },
                            { label: "Create rule", onSelect: () => setRulePickerId(rulePickerId === item.id ? null : item.id) },
                          ]}
                        />
                      </div>
                    )}
                    {rulePickerId === item.id && (
                      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle p-2">
                        <span className="text-sm text-secondary">Always file messages from this sender as:</span>
                        <select
                          value={ruleCategory}
                          onChange={(e) => setRuleCategory(e.target.value)}
                          className="h-8 rounded-md border border-border-default bg-surface px-2 text-sm text-primary"
                        >
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c.replace("_", " ")}
                            </option>
                          ))}
                        </select>
                        <Button size="sm" onClick={() => createSenderRule(item.id)}>
                          Save rule
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRulePickerId(null)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                    {item.reviewState === "new" && correctingId === item.id && fields && (
                      <CorrectionForm
                        itemId={item.id}
                        fields={fields}
                        onDone={() => {
                          setCorrectingId(null);
                          refresh();
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

      {!isLoading && cursor && (
        <div className="flex justify-center pt-2">
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
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
  const [mode, setMode] = useState<"text" | "url" | "voice">("text");
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [url, setUrl] = useState("");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setVoiceSupported(getSpeechRecognition() !== null);
  }, []);

  /** §CAP-006 "voice note" — records via the same feature-detected Web Speech API already used for
   * Ask's voice input, `continuous: true` so a longer note isn't cut off after the first pause (unlike
   * Ask's one-shot query recognition). Live transcript is editable before submit rather than auto-filed —
   * speech recognition can mishear a word, and this is the only capture path with no confirmation step
   * otherwise. */
  function toggleRecording() {
    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let finalText = "";
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i]?.[0]?.transcript;
        if (transcript) finalText += `${transcript} `;
      }
      setVoiceTranscript(finalText.trim());
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "url") {
        await api.post("/v1/ingestion/url", { url });
        setUrl("");
      } else if (mode === "voice") {
        const firstLine = voiceTranscript.trim().split("\n")[0]?.slice(0, 500) || "Voice note";
        await api.post("/v1/ingestion/manual", { subject: firstLine, bodyText: voiceTranscript });
        setVoiceTranscript("");
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
            {(["text", "url", ...(voiceSupported ? (["voice"] as const) : [])] as const).map((m) => (
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
                {m === "text" ? "Paste text" : m === "url" ? "From a URL" : "Voice note"}
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
          ) : mode === "url" ? (
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
          ) : (
            <>
              <p className="text-sm text-tertiary">Speak a quick note — review the transcript before saving.</p>
              <Button type="button" size="sm" variant={listening ? "critical" : "secondary"} onClick={toggleRecording}>
                {listening ? "Stop recording" : "Start recording"}
              </Button>
              <div>
                <Label htmlFor="capture-voice-transcript">Transcript</Label>
                <Textarea
                  id="capture-voice-transcript"
                  rows={6}
                  value={voiceTranscript}
                  onChange={(e) => setVoiceTranscript(e.target.value)}
                  placeholder="Your words will appear here as you speak."
                  required
                  maxLength={50_000}
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
