"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Label } from "@/components/ui/input";

type Category = "household_roster" | "vehicles" | "properties" | "pets" | "identity_records" | "documents" | "medications_notes" | "emergency_instructions";

const CATEGORY_OPTIONS: Array<{ value: Category; label: string }> = [
  { value: "household_roster", label: "Household roster" },
  { value: "vehicles", label: "Vehicles" },
  { value: "properties", label: "Properties" },
  { value: "pets", label: "Pets" },
  { value: "identity_records", label: "Identity records" },
  { value: "documents", label: "Flagged documents" },
  { value: "medications_notes", label: "Medications notes" },
  { value: "emergency_instructions", label: "Emergency instructions" },
];

type Status = "draft" | "armed" | "pending_release" | "released" | "revoked";

interface LegacyReleaseConfig {
  id: string;
  trustedContactEmail: string;
  categories: Category[];
  waitingPeriodDays: number;
  status: Status;
  releaseEligibleAt: string | null;
  inactivityThresholdDays: number | null;
  inactivityWarningSentAt: string | null;
}

interface CurrentUser {
  lastActiveAt: string;
}

const STATUS_LABEL: Record<Status, string> = {
  draft: "Draft — not yet active",
  armed: "Active",
  pending_release: "Pending release",
  released: "Released",
  revoked: "Revoked",
};

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * §35 SHARE-006 "Future trusted delegate / legacy release" — spec's own text: "Optional preconfigured
 * release of selected information under a carefully verified process... no automatic account takeover.
 * Release criteria, waiting period, multi-party verification and revocation must be explicit." This page
 * covers the owner's OWN setup/revocation, including the owner-chosen "release criteria" itself — an
 * optional inactivity threshold ("if I'm inactive for N days") that LegacyReleaseService.scanInactivity (a
 * recurring background job, not anything this page calls directly) checks against real login/session
 * activity. The actual release process beyond that trigger (a human admin OR the inactivity job starting a
 * mandatory waiting period, a separate superadmin finalizing it only after that period elapses) is an
 * internal process, not something triggered from here — see LegacyReleaseService's own doc comment for the
 * full lifecycle.
 */
export default function LegacyReleasePage() {
  const { data: configs, mutate } = useSWR<LegacyReleaseConfig[]>("/v1/legacy-release", swrFetcher);
  // Only used to show "You were last active on..." below — see users.lastActiveAt's own doc comment
  // (packages/db/src/schema/identity.ts) for exactly what keeps this current.
  const { data: me } = useSWR<CurrentUser>("/v1/auth/me", swrFetcher);

  const [creating, setCreating] = useState(false);
  const [trustedContactEmail, setTrustedContactEmail] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [waitingPeriodDays, setWaitingPeriodDays] = useState("30");
  const [inactivityThresholdDays, setInactivityThresholdDays] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirmTyped, setConfirmTyped] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  function toggleCategory(c: Category) {
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function createDraft(e: FormEvent) {
    e.preventDefault();
    setCreatingBusy(true);
    setCreateError(null);
    try {
      await api.post("/v1/legacy-release", {
        trustedContactEmail,
        categories,
        waitingPeriodDays: Number(waitingPeriodDays),
        // Optional — a config with no inactivity threshold can still be released, just only by a human
        // admin manually starting it (see LegacyReleaseService's own doc comment).
        inactivityThresholdDays: inactivityThresholdDays.trim() ? Number(inactivityThresholdDays) : undefined,
      });
      setCreating(false);
      setTrustedContactEmail("");
      setCategories([]);
      setInactivityThresholdDays("");
      mutate();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setCreatingBusy(false);
    }
  }

  async function confirmConfig(id: string) {
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      await api.post(`/v1/legacy-release/${id}/confirm`, { password: confirmPassword });
      setConfirmingId(null);
      setConfirmTyped("");
      setConfirmPassword("");
      mutate();
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : "Couldn't confirm this. Please try again.");
    } finally {
      setConfirmBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revoke this legacy release configuration? Your trusted contact will never receive anything from it.")) return;
    await api.delete(`/v1/legacy-release/${id}`);
    mutate();
  }

  async function cancelPending(id: string) {
    await api.post(`/v1/legacy-release/${id}/cancel-pending-release`);
    mutate();
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link href="/settings/sharing" className="text-sm text-tertiary hover:text-primary">
          ← Sharing
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Legacy release</h1>
        <p className="text-sm text-tertiary">
          Preconfigure a trusted contact to receive selected information later, under a carefully verified process — never an
          automatic account takeover.
        </p>
        {me?.lastActiveAt && (
          <p className="text-xs text-tertiary">
            You were last active {daysSince(me.lastActiveAt) === 0 ? "today" : `${daysSince(me.lastActiveAt)} day${daysSince(me.lastActiveAt) === 1 ? "" : "s"} ago`} (
            {new Date(me.lastActiveAt).toLocaleString()}).
          </p>
        )}
      </header>

      {configs && configs.length === 0 && !creating && (
        <EmptyState
          title="Nothing set up yet"
          description="Choose a trusted contact and exactly what they'd receive. Nothing is released until a verified process — separate from you — confirms it, and you can cancel any time before that happens."
          action={<Button onClick={() => setCreating(true)}>Set up legacy release</Button>}
        />
      )}

      {configs?.map((c) => (
        <Card key={c.id}>
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">{c.trustedContactEmail}</p>
                <p className="text-sm text-tertiary">
                  {c.categories.length} categor{c.categories.length === 1 ? "y" : "ies"} — {c.waitingPeriodDays}-day waiting period
                </p>
              </div>
              <Badge tone={c.status === "revoked" ? "neutral" : c.status === "released" ? "critical" : c.status === "pending_release" ? "warning" : "positive"}>
                {STATUS_LABEL[c.status]}
              </Badge>
            </div>

            {c.status === "armed" &&
              (c.inactivityThresholdDays ? (
                <p className="text-xs text-tertiary">
                  Starts automatically after {c.inactivityThresholdDays} days of inactivity
                  {me?.lastActiveAt ? ` — you're at ${daysSince(me.lastActiveAt)} of ${c.inactivityThresholdDays} days now` : ""}. You&apos;ll get a warning email first,
                  with a chance to sign in and reset the clock.
                </p>
              ) : (
                <p className="text-xs text-tertiary">No inactivity trigger set — this can only be started by a support admin.</p>
              ))}

            {c.status === "pending_release" && (
              <div className="space-y-2 rounded-lg bg-warning-subtle p-3">
                <p className="text-sm text-warning-subtle-text">
                  A release was started and is waiting until {c.releaseEligibleAt ? new Date(c.releaseEligibleAt).toLocaleString() : "the waiting period ends"}. If
                  this wasn&apos;t you, cancel it now.
                </p>
                <Button variant="secondary" size="sm" onClick={() => cancelPending(c.id)}>
                  I&apos;m still here — cancel this
                </Button>
              </div>
            )}

            {c.status === "draft" && confirmingId !== c.id && (
              <Button size="sm" onClick={() => setConfirmingId(c.id)}>
                Confirm &amp; activate
              </Button>
            )}
            {c.status === "draft" && confirmingId === c.id && (
              <div className="space-y-3 rounded-lg border border-border-default p-3">
                <p className="text-sm text-secondary">
                  This activates a real, standing configuration: after a carefully verified process (never automatic), {c.trustedContactEmail}{" "}
                  could receive the categories you selected. Type CONFIRM and re-enter your password to activate.
                </p>
                <div>
                  <Label htmlFor="confirm-typed">Type CONFIRM</Label>
                  <Input id="confirm-typed" value={confirmTyped} onChange={(e) => setConfirmTyped(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="confirm-password">Your password</Label>
                  <Input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
                </div>
                {confirmError && <p className="text-sm text-critical">{confirmError}</p>}
                <div className="flex gap-2">
                  <Button size="sm" loading={confirmBusy} disabled={confirmTyped !== "CONFIRM" || !confirmPassword} onClick={() => confirmConfig(c.id)}>
                    Activate
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirmingId(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {c.status !== "released" && (
              <Button variant="secondary" size="sm" onClick={() => revoke(c.id)}>
                Revoke
              </Button>
            )}
          </CardBody>
        </Card>
      ))}

      {!creating && configs && configs.length > 0 && (
        <Button variant="secondary" onClick={() => setCreating(true)}>
          Add another
        </Button>
      )}

      {creating && (
        <Card>
          <CardBody>
            <form onSubmit={createDraft} className="space-y-4">
              <div>
                <Label htmlFor="trusted-email">Trusted contact&apos;s email</Label>
                <Input id="trusted-email" type="email" value={trustedContactEmail} onChange={(e) => setTrustedContactEmail(e.target.value)} required />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-secondary">What to include</label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORY_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => toggleCategory(opt.value)}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        categories.includes(opt.value) ? "border-brand-default bg-brand-subtle text-brand-subtle-text" : "border-border-default text-tertiary"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label htmlFor="waiting-period">Waiting period (days)</Label>
                <Input id="waiting-period" type="number" min={7} max={365} value={waitingPeriodDays} onChange={(e) => setWaitingPeriodDays(e.target.value)} />
                <p className="mt-1 text-xs text-tertiary">
                  How long a started release must wait, giving you the chance to cancel it, before it can be finalized. At least 7 days.
                </p>
              </div>
              <div>
                <Label htmlFor="inactivity-threshold">Start automatically if I&apos;m inactive for this many days (optional)</Label>
                <Input
                  id="inactivity-threshold"
                  type="number"
                  min={1}
                  max={3650}
                  placeholder="e.g. 90"
                  value={inactivityThresholdDays}
                  onChange={(e) => setInactivityThresholdDays(e.target.value)}
                />
                <p className="mt-1 text-xs text-tertiary">
                  Leave blank to require a support admin to start this manually. If set, you&apos;ll get a warning email once you&apos;re 75% of the way
                  there, well before anything actually starts — signing back in always resets the clock.
                </p>
              </div>
              {createError && <p className="text-sm text-critical">{createError}</p>}
              <div className="flex gap-2">
                <Button type="submit" loading={creatingBusy} disabled={!trustedContactEmail.trim() || categories.length === 0}>
                  Save as draft
                </Button>
                <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
