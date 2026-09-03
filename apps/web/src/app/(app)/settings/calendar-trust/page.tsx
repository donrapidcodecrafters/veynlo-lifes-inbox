"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

interface TrustedRescheduleRule {
  id: string;
  senderDomain: string;
  createdAt: string;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — the standalone
 * management view for `calendarRescheduleTrustedRules`, independent of any specific offered inbox item
 * (the item-level "Always trust reschedule emails like this one" checkbox lives on the offered-change
 * card itself in the Inbox — see InboxService.applyRescheduleChange's `trustSender` option). Without a
 * trusted rule for a sender's domain, a reschedule email only ever OFFERS the change for review; adding
 * one here (or checking that box) lets the NEXT reschedule from that sender apply automatically.
 */
export default function CalendarTrustSettingsPage() {
  const { data: rules, isLoading, mutate } = useSWR<TrustedRescheduleRule[]>("/v1/inbox/reschedule-trust-rules", swrFetcher);
  const [senderDomain, setSenderDomain] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function addRule(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      await api.post("/v1/inbox/reschedule-trust-rules", { senderDomain });
      setSenderDomain("");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that rule. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function removeRule(id: string) {
    setRemovingId(id);
    try {
      await api.delete(`/v1/inbox/reschedule-trust-rules/${id}`);
      mutate();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Trusted reschedule senders</h1>
        <p className="mt-1 text-sm text-tertiary">
          By default, when an email describes a discovered appointment moving to a new date or time, Veynlo offers the change
          for you to review instead of applying it automatically. Add a sender domain here — e.g. &quot;united.com&quot; — to let
          future reschedule emails from that sender apply automatically instead.
        </p>
      </header>

      <Card>
        <CardBody>
          <form onSubmit={addRule} className="flex flex-wrap items-end gap-3" noValidate>
            <div className="min-w-[200px] flex-1">
              <Label htmlFor="sender-domain">Sender domain or email</Label>
              <Input
                id="sender-domain"
                placeholder="united.com"
                value={senderDomain}
                onChange={(e) => setSenderDomain(e.target.value)}
                required
              />
            </div>
            <Button type="submit" loading={adding}>
              Add
            </Button>
          </form>
          <FieldError>{error ?? undefined}</FieldError>
        </CardBody>
      </Card>

      {!isLoading && rules && rules.length === 0 && (
        <EmptyState
          title="No trusted senders yet"
          description="Every reschedule email is offered for your review until you trust a sender here, or check 'Always trust reschedule emails like this one' on an offered change in your Inbox."
        />
      )}

      {rules && rules.length > 0 && (
        <ul className="space-y-3">
          {rules.map((rule) => (
            <li key={rule.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[0.9375rem] font-medium text-primary">{rule.senderDomain}</p>
                    <p className="text-sm text-tertiary">Trusted since {formatWhen(rule.createdAt)}</p>
                  </div>
                  <Button variant="secondary" size="sm" loading={removingId === rule.id} onClick={() => removeRule(rule.id)}>
                    Remove
                  </Button>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
