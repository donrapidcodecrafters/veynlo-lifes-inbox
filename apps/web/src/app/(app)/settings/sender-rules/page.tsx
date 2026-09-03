"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

type SenderRuleAction = "always_school" | "always_bills" | "ignore" | "attachments_only" | "household_shared";

interface SenderRule {
  id: string;
  senderDomain: string | null;
  senderEmail: string | null;
  action: SenderRuleAction;
  createdAt: string;
}

const ACTION_LABEL: Record<SenderRuleAction, string> = {
  always_school: "Always treat as School",
  always_bills: "Always treat as Bills",
  ignore: "Ignore",
  attachments_only: "Keep only attachments",
  household_shared: "Household shared",
};

const ACTION_OPTIONS: SenderRuleAction[] = ["always_school", "always_bills", "ignore", "attachments_only", "household_shared"];

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

/**
 * MAIL-006 "User sender rules" — "Let users teach Life Inbox once." Standalone list/add/remove settings
 * surface, mirroring /settings/calendar-trust's identical shape (CAL-004's single-purpose trusted-rule
 * page). The inline "Always treat mail from this sender as..." action reachable from an Inbox item's own
 * correction flow (see InboxService.addSenderRuleFromInboxItem) creates domain-scoped rules that show up
 * here too — this page is the one place to review/remove every rule regardless of how it was created.
 */
export default function SenderRulesSettingsPage() {
  const { data: rules, isLoading, mutate } = useSWR<SenderRule[]>("/v1/inbox/sender-rules", swrFetcher);
  const [sender, setSender] = useState("");
  const [action, setAction] = useState<SenderRuleAction>("always_bills");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function addRule(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      const trimmed = sender.trim();
      const isEmail = trimmed.includes("@") && !trimmed.startsWith("@");
      await api.post("/v1/inbox/sender-rules", isEmail ? { senderEmail: trimmed, action } : { senderDomain: trimmed, action });
      setSender("");
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
      await api.delete(`/v1/inbox/sender-rules/${id}`);
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
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Sender rules</h1>
        <p className="mt-1 text-sm text-tertiary">
          Teach Veynlo how to handle mail from a specific sender or domain once: always file it as School or Bills, ignore it
          entirely, keep only its attachments, or mark it as shared with your household — instead of correcting the same
          sender every time.
        </p>
      </header>

      <Card>
        <CardBody>
          <form onSubmit={addRule} className="flex flex-wrap items-end gap-3" noValidate>
            <div className="min-w-[220px] flex-1">
              <Label htmlFor="sender-rule-sender">Sender domain or email</Label>
              <Input
                id="sender-rule-sender"
                placeholder="school.example.org or billing@acme.com"
                value={sender}
                onChange={(e) => setSender(e.target.value)}
                required
              />
            </div>
            <div className="min-w-[200px]">
              <Label htmlFor="sender-rule-action">Always treat as</Label>
              <select
                id="sender-rule-action"
                value={action}
                onChange={(e) => setAction(e.target.value as SenderRuleAction)}
                className="h-9 w-full rounded-lg border border-border-subtle bg-surface px-3 text-sm text-primary"
              >
                {ACTION_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {ACTION_LABEL[opt]}
                  </option>
                ))}
              </select>
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
          title="No sender rules yet"
          description="Add a rule above, or use 'Always treat mail from this sender as...' when correcting a misclassified item in your Inbox."
        />
      )}

      {rules && rules.length > 0 && (
        <ul className="space-y-3">
          {rules.map((rule) => (
            <li key={rule.id}>
              <Card>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[0.9375rem] font-medium text-primary">{rule.senderDomain ?? rule.senderEmail}</p>
                    <p className="text-sm text-tertiary">
                      {ACTION_LABEL[rule.action]} · added {formatWhen(rule.createdAt)}
                    </p>
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
