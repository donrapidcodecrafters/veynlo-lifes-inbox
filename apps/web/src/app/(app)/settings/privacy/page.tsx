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
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  lastSuccessfulSyncAt: string | null;
}

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
};

/**
 * §Account/security "privacy/consent center" (PRIV-001) — one page assembling what was previously
 * scattered across Connections/Billing/Data-export/Danger-zone: what Veynlo can currently see, whether
 * it's allowed to run AI on what it captures, and the export/delete controls PRIV-002 already built.
 */
export default function PrivacyPage() {
  const { data: me, mutate: mutateMe } = useSWR<Me>("/v1/auth/me", swrFetcher);
  const { data: connections } = useSWR<Connection[]>("/v1/connectors", swrFetcher);
  const [updatingAi, setUpdatingAi] = useState(false);

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
