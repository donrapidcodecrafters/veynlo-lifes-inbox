"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { Input, Label, FieldError } from "@/components/ui/input";

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  suggestedActions: string[];
  linkedResourceType: string | null;
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
};

export default function InboxPage() {
  const [filter, setFilter] = useState<"new" | "all">("new");
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const { data, isLoading, mutate } = useSWR<InboxItem[]>(
    filter === "new" ? "/v1/inbox?reviewState=new" : "/v1/inbox",
    swrFetcher,
  );

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    mutate();
  }

  async function snooze(id: string) {
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await api.post(`/v1/inbox/${id}/snooze`, { until });
    mutate();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Inbox</h1>
          <p className="mt-1 text-sm text-tertiary">Newly discovered information to review.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-subtle p-1">
          {(["new", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                filter === f ? "bg-surface text-primary shadow-xs" : "text-tertiary"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

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
                        </div>
                        <p className="text-[0.9375rem] font-medium text-primary">{item.summary}</p>
                      </div>
                    </div>
                    {item.reviewState === "new" && correctingId !== item.id && (
                      <div className="flex gap-2">
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
