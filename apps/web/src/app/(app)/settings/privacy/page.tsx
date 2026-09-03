"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input, Label } from "@/components/ui/input";
import { FetchError } from "@/components/ui/fetch-error";
import { usePersonalizationPreferences } from "@/hooks/use-personalization";
import { useFinancialPrivacy } from "@/lib/financial-privacy-context";

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
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  dropbox: "Dropbox",
  google_tasks: "Google Tasks",
  microsoft_todo: "Microsoft To Do",
};

// Same mapping the Connections page uses for connector health — this page's own three-way ternary
// (healthy/disconnected/else) previously lumped "reauth_required" in with ordinary transient states like
// "initializing", so an integration that actually needed the user to re-authenticate looked no more urgent
// than one that was still finishing its first sync.
const HEALTH_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  healthy: "positive",
  initializing: "neutral",
  degraded: "warning",
  rate_limited: "neutral",
  reauth_required: "critical",
  permission_reduced: "warning",
  provider_outage: "warning",
  disconnected: "neutral",
};

/**
 * FIN-007 "Allow amounts and account names to be hidden on Home, widgets, household surfaces and
 * notifications... Mask by default on lock screen; biometric reveal option." The toggle controls the
 * stored preference (persists across sessions/devices); "Reveal" is a per-session step-up that never
 * touches that preference — leaving this page (or a fresh sign-in elsewhere) always starts masked again,
 * matching the spec's "mask by default" line.
 */
function FinancialPrivacySection() {
  const { data: personalization, mutate: mutatePersonalization } = usePersonalizationPreferences();
  const { masked, revealed, requestReveal, hide } = useFinancialPrivacy();
  const [updating, setUpdating] = useState(false);
  const [passwordPromptOpen, setPasswordPromptOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [revealBusy, setRevealBusy] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  async function toggleEnabled(enabled: boolean) {
    setUpdating(true);
    mutatePersonalization({ ...personalization, financialPrivacyModeEnabled: enabled }, false);
    try {
      await api.put("/v1/personalization-preferences", { financialPrivacyModeEnabled: enabled });
    } finally {
      mutatePersonalization();
      setUpdating(false);
    }
  }

  async function reveal(withPassword?: string) {
    setRevealBusy(true);
    setRevealError(null);
    try {
      const result = await requestReveal(withPassword);
      if (result.ok) {
        setPasswordPromptOpen(false);
        setPassword("");
        return;
      }
      if (result.needsPassword) {
        setPasswordPromptOpen(true);
        return;
      }
      setRevealError(result.error ?? "Couldn't verify — try again.");
    } finally {
      setRevealBusy(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <Switch
          id="financial-privacy-mode"
          label="Financial privacy mode"
          description="Mask dollar amounts and account names on Home, widgets, and notifications. Turn this on and they show as “••••” until you confirm your password."
          checked={personalization.financialPrivacyModeEnabled}
          disabled={updating}
          onCheckedChange={toggleEnabled}
        />
        {personalization.financialPrivacyModeEnabled && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-3">
            <p className="text-sm text-tertiary">{masked ? "Amounts are currently hidden on this device." : "Amounts are revealed for this session."}</p>
            {masked && !passwordPromptOpen && (
              <Button size="sm" variant="secondary" loading={revealBusy} onClick={() => reveal()}>
                Reveal
              </Button>
            )}
            {revealed && (
              <Button size="sm" variant="ghost" onClick={hide}>
                Hide again
              </Button>
            )}
          </div>
        )}
        {passwordPromptOpen && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              reveal(password);
            }}
            className="flex flex-wrap items-end gap-2"
            noValidate
          >
            <div>
              <Label htmlFor="financial-privacy-password">Confirm your password to reveal amounts</Label>
              <Input
                id="financial-privacy-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
              />
            </div>
            <Button type="submit" size="sm" loading={revealBusy}>
              Unlock
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                setPasswordPromptOpen(false);
                setPassword("");
              }}
            >
              Cancel
            </Button>
          </form>
        )}
        {revealError && <p className="text-sm text-critical-subtle-text">{revealError}</p>}
      </CardBody>
    </Card>
  );
}

/**
 * §Account/security "privacy/consent center" (PRIV-001) — one page assembling what was previously
 * scattered across Connections/Billing/Data-export/Danger-zone: what Veynlo can currently see, whether
 * it's allowed to run AI on what it captures, and the export/delete controls PRIV-002 already built.
 */
export default function PrivacyPage() {
  const { data: me, mutate: mutateMe } = useSWR<Me>("/v1/auth/me", swrFetcher);
  const { data: connections, error: connectionsError, mutate: mutateConnections } = useSWR<Connection[]>("/v1/connectors", swrFetcher);
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
        {/* Bug fix: every sibling settings page (household, notifications, security) has a "← Settings"
            back-link above its heading; this one was the only one missing it — confirmed side by side in
            live screenshots, not just a source-reading guess. With no back link and no top nav on this
            route, a mobile-width visitor's only way back to /settings was the browser back button. */}
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Privacy</h1>
        <p className="mt-1 text-sm text-tertiary">What Veynlo can see, what it does with it, and your controls.</p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">AI processing</h2>
        <Card>
          <CardBody>
            {/* `?? true` while `me` was still loading meant a visitor who'd turned AI processing off saw
                it flash back "on" on every page load, before snapping to the real value — misleading for
                a privacy control. Disabled (not just defaulted) until the real value is known. */}
            <Switch
              id="ai-processing"
              label="Let Veynlo use AI to understand what's captured"
              description="Turning this off stops all AI classification and extraction — new items are filed as-is, with nothing pulled out automatically."
              checked={me ? me.aiProcessingEnabled : true}
              disabled={updatingAi || !me}
              onCheckedChange={toggleAiProcessing}
            />
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Financial privacy</h2>
        <FinancialPrivacySection />
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
            {/* Bug fix: found live via a forced 500 on GET /v1/connectors — this section only ever
                checked `!connections`, so a fetch error (connections stays undefined, same as "still
                loading") left "Loading…" on screen forever with no way to recover short of a full page
                reload. Distinguish the error case and offer the same Retry affordance every other
                settings page already has. */}
            {connectionsError && !connections && (
              <FetchError
                what="your connections"
                message={connectionsError instanceof ApiError ? connectionsError.message : undefined}
                onRetry={() => mutateConnections()}
              />
            )}
            {!connections && !connectionsError && <p className="text-sm text-tertiary">Loading…</p>}
            {connections && connections.length === 0 && (
              <p className="text-sm text-tertiary">Nothing connected yet — Veynlo only reads what you connect.</p>
            )}
            {connections && connections.length > 0 && (
              <ul className="space-y-2">
                {connections.map((c) => (
                  <li key={c.id} className="flex items-center justify-between text-sm">
                    <span className="text-primary">{PROVIDER_LABEL[c.provider] ?? c.provider}</span>
                    <span className="flex items-center gap-2 text-tertiary">
                      <Badge tone={HEALTH_TONE[c.health] ?? "warning"}>{c.health.replace(/_/g, " ")}</Badge>
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
