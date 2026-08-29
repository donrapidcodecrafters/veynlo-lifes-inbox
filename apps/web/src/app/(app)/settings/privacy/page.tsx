"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

interface Me {
  id: string;
  email: string | null;
  aiProcessingEnabled: boolean;
  disabledMailCategories: string[];
  dataRetentionDays: number | null;
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  lastSuccessfulSyncAt: string | null;
}

interface SenderRule {
  id: string;
  senderAddress: string;
  action: "block" | "category_override";
  categoryOverride: string | null;
  createdAt: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
  google_tasks: "Google Tasks",
  microsoft_todo: "Microsoft To Do",
};

// Matches services/api/src/modules/identity/dto.ts's MAIL_CATEGORIES — restricted to categories
// IngestionService.classifyAndExtract actually dispatches to an extractor.
const MAIL_CATEGORIES = [
  { value: "receipt", label: "Receipts" },
  { value: "shipment", label: "Shipments" },
  { value: "bill", label: "Bills" },
  { value: "subscription", label: "Subscriptions" },
  { value: "calendar_event", label: "Calendar events" },
  { value: "travel", label: "Travel" },
  { value: "warranty", label: "Warranties" },
] as const;

const RETENTION_OPTIONS = [
  { value: "", label: "Keep forever" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years" },
] as const;

/**
 * §Account/security "privacy/consent center" (PRIV-001) — one page assembling what was previously
 * scattered across Connections/Billing/Data-export/Danger-zone: what Veynlo can currently see, whether
 * it's allowed to run AI on what it captures, and the export/delete controls PRIV-002 already built.
 */
export default function PrivacyPage() {
  const { data: me, mutate: mutateMe } = useSWR<Me>("/v1/auth/me", swrFetcher);
  const { data: connections } = useSWR<Connection[]>("/v1/connectors", swrFetcher);
  const { data: senderRules, mutate: mutateSenderRules } = useSWR<SenderRule[]>("/v1/inbox/sender-rules", swrFetcher);
  const [updatingAi, setUpdatingAi] = useState(false);
  const [updatingCategories, setUpdatingCategories] = useState(false);
  const [updatingRetention, setUpdatingRetention] = useState(false);
  const [removingRuleId, setRemovingRuleId] = useState<string | null>(null);

  async function toggleAiProcessing(enabled: boolean) {
    setUpdatingAi(true);
    mutateMe(me ? { ...me, aiProcessingEnabled: enabled } : me, false);
    try {
      await api.post("/v1/auth/ai-processing", { enabled });
    } finally {
      mutateMe();
      setUpdatingAi(false);
    }
  }

  async function toggleCategory(category: string, disabled: boolean) {
    if (!me) return;
    const next = disabled ? [...me.disabledMailCategories, category] : me.disabledMailCategories.filter((c) => c !== category);
    setUpdatingCategories(true);
    mutateMe({ ...me, disabledMailCategories: next }, false);
    try {
      await api.post("/v1/auth/disabled-mail-categories", { categories: next });
    } finally {
      mutateMe();
      setUpdatingCategories(false);
    }
  }

  async function setRetention(daysRaw: string) {
    const days = daysRaw === "" ? null : Number(daysRaw);
    setUpdatingRetention(true);
    mutateMe(me ? { ...me, dataRetentionDays: days } : me, false);
    try {
      await api.post("/v1/auth/data-retention", { days });
    } finally {
      mutateMe();
      setUpdatingRetention(false);
    }
  }

  async function removeSenderRule(ruleId: string) {
    setRemovingRuleId(ruleId);
    try {
      await api.post(`/v1/inbox/sender-rules/${ruleId}/delete`);
      await mutateSenderRules();
    } finally {
      setRemovingRuleId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Privacy</h1>
        <p className="mt-1 text-sm text-tertiary">What Veynlo can see, what it does with it, and your controls.</p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">AI processing</h2>
        <Card>
          <CardBody>
            <Switch
              id="ai-processing"
              label="Let Veynlo use AI to understand what's captured"
              description="Turning this off stops all AI classification and extraction — new items are filed as-is, with nothing pulled out automatically."
              checked={me?.aiProcessingEnabled ?? true}
              disabled={updatingAi}
              onCheckedChange={toggleAiProcessing}
            />
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Mail categories</h2>
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm text-tertiary">
              Turn off any category you&apos;d rather Veynlo never extract from your mail at all — those messages are filed as-is, nothing pulled out.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {MAIL_CATEGORIES.map((cat) => {
                const disabled = me?.disabledMailCategories.includes(cat.value) ?? false;
                return (
                  <Switch
                    key={cat.value}
                    id={`category-${cat.value}`}
                    label={cat.label}
                    checked={!disabled}
                    disabled={updatingCategories}
                    onCheckedChange={(enabled) => toggleCategory(cat.value, !enabled)}
                  />
                );
              })}
            </div>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Blocked senders</h2>
        <Card>
          <CardBody className="space-y-3">
            {!senderRules && <p className="text-sm text-tertiary">Loading…</p>}
            {senderRules && senderRules.length === 0 && (
              <p className="text-sm text-tertiary">No sender rules yet — block a sender from any Inbox item to stop it from being processed at all.</p>
            )}
            {senderRules && senderRules.length > 0 && (
              <ul className="space-y-2">
                {senderRules.map((rule) => (
                  <li key={rule.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-primary">{rule.senderAddress}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={rule.action === "block" ? "critical" : "neutral"}>
                        {rule.action === "block" ? "Blocked" : `Always: ${rule.categoryOverride}`}
                      </Badge>
                      <Button size="sm" variant="ghost" loading={removingRuleId === rule.id} onClick={() => removeSenderRule(rule.id)}>
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">What's connected</h2>
          <Link href="/connections" className="text-sm font-medium text-brand hover:underline">
            Manage →
          </Link>
        </div>
        <Card>
          <CardBody className="space-y-3">
            {!connections && <p className="text-sm text-tertiary">Loading…</p>}
            {connections && connections.length === 0 && (
              <p className="text-sm text-tertiary">Nothing connected yet — Veynlo only reads what you connect.</p>
            )}
            {connections && connections.length > 0 && (
              <ul className="space-y-2">
                {connections.map((c) => (
                  <li key={c.id} className="flex items-center justify-between text-sm">
                    <span className="text-primary">{PROVIDER_LABEL[c.provider] ?? c.provider}</span>
                    <span className="flex items-center gap-2 text-tertiary">
                      <Badge tone={c.health === "healthy" ? "positive" : c.health === "disconnected" ? "neutral" : "warning"}>
                        {c.health.replace(/_/g, " ")}
                      </Badge>
                      {c.lastSuccessfulSyncAt && <span>Synced {new Date(c.lastSuccessfulSyncAt).toLocaleDateString()}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Your data</h2>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Export your data</p>
              <p className="text-sm text-tertiary">Download a copy of everything Veynlo has recorded for you.</p>
            </div>
            <Link href="/settings/data-export">
              <Button variant="secondary">Export</Button>
            </Link>
          </CardBody>
        </Card>
        <Card className="mt-3">
          <CardBody className="flex items-center justify-between gap-4">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Raw evidence retention</p>
              <p className="text-sm text-tertiary">
                How long to keep the original captured email content (subject, snippet, sender) once it&apos;s been processed. Anything
                already extracted — receipts, bills, events — is kept regardless.
              </p>
            </div>
            <select
              value={me?.dataRetentionDays != null ? String(me.dataRetentionDays) : ""}
              onChange={(e) => setRetention(e.target.value)}
              disabled={updatingRetention}
              className="h-10 shrink-0 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary disabled:opacity-60"
            >
              {RETENTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Delete your account</h2>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Permanently delete your account</p>
              <p className="text-sm text-tertiary">This can&apos;t be undone. Handled from Settings for an extra confirmation step.</p>
            </div>
            <Link href="/settings#danger-zone">
              <Button variant="critical">Go to Settings</Button>
            </Link>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
