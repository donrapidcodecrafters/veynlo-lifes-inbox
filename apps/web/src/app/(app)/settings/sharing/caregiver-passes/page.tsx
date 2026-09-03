"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface MyHousehold {
  household: { id: string; name: string };
}

type DayPassScope = "schedule" | "contacts" | "instructions" | "pets" | "dependents";

const SCOPE_OPTIONS: Array<{ value: DayPassScope; label: string }> = [
  { value: "instructions", label: "Access instructions" },
  { value: "contacts", label: "Household contacts" },
  { value: "schedule", label: "Schedule" },
  { value: "pets", label: "Pet care" },
  { value: "dependents", label: "Kids" },
];

interface DayPass {
  id: string;
  label: string;
  scopes: DayPassScope[];
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
  expiredAt: string | null;
  hasPasscode: boolean;
  createdAt: string;
}

function statusOf(pass: DayPass): { text: string; tone: "positive" | "neutral" } {
  if (pass.revokedAt) return { text: "Revoked", tone: "neutral" };
  if (pass.expiredAt || new Date(pass.expiresAt) < new Date()) return { text: "Expired", tone: "neutral" };
  return { text: `Active until ${new Date(pass.expiresAt).toLocaleString()}`, tone: "positive" };
}

/**
 * §35 SHARE-005 "Caregiver/day pass" — "Time-bound collection for caregiver logistics. Schedule,
 * contacts, access instructions, pet/kid tasks; automatically expires." Distinct from the household's
 * caregiver DELEGATION feature (settings/household — an ongoing, account-holding member's scoped access):
 * this mints a short-lived, passcode-optional public link a babysitter/house-sitter with no Veynlo account
 * can open directly.
 */
export default function CaregiverDayPassesPage() {
  const { data: myHouseholds } = useSWR<MyHousehold[]>("/v1/households", swrFetcher);
  const householdId = myHouseholds?.[0]?.household.id ?? null;
  const { data: passes, mutate } = useSWR<DayPass[]>(householdId ? `/v1/caregiver-day-passes/${householdId}` : null, swrFetcher);

  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<DayPassScope[]>(["instructions"]);
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [passcode, setPasscode] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null);

  function toggleScope(scope: DayPassScope) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function createPass(e: FormEvent) {
    e.preventDefault();
    if (!householdId) return;
    setCreating(true);
    setCreateError(null);
    setNewLinkUrl(null);
    try {
      const { token } = await api.post<{ id: string; token: string }>(`/v1/caregiver-day-passes/${householdId}`, {
        label,
        scopes,
        expiresInHours: Number(expiresInHours),
        passcode: passcode.trim() || undefined,
      });
      setNewLinkUrl(`${window.location.origin}/day-pass/${token}`);
      setLabel("");
      setPasscode("");
      mutate();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Couldn't create a day pass. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(passId: string, passLabel: string) {
    if (!householdId) return;
    if (!window.confirm(`End "${passLabel}" now? Anyone using it loses access immediately.`)) return;
    await api.delete(`/v1/caregiver-day-passes/${householdId}/${passId}`);
    mutate();
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link href="/settings/sharing" className="text-sm text-tertiary hover:text-primary">
          ← Sharing
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Caregiver day pass</h1>
        <p className="text-sm text-tertiary">
          A time-boxed link for a babysitter or house-sitter — no Veynlo account needed. Choose exactly what to include; it expires
          on its own.
        </p>
      </header>

      {!myHouseholds && <p className="text-sm text-tertiary">Loading…</p>}
      {myHouseholds && myHouseholds.length === 0 && (
        <EmptyState title="No household yet" description="Set up a household in Settings → Household before creating a day pass." />
      )}

      {householdId && (
        <>
          <Card>
            <CardBody>
              <form onSubmit={createPass} className="space-y-4">
                <div>
                  <label className="mb-1 block text-xs font-medium text-secondary">Label</label>
                  <input
                    type="text"
                    placeholder="e.g. Saturday night sitter"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    required
                    className="h-9 w-full rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-secondary">What to include</label>
                  <div className="flex flex-wrap gap-2">
                    {SCOPE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggleScope(opt.value)}
                        className={`rounded-full border px-3 py-1 text-xs ${
                          scopes.includes(opt.value) ? "border-brand-default bg-brand-subtle text-brand-subtle-text" : "border-border-default text-tertiary"
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-secondary">Expires in</label>
                    <select
                      value={expiresInHours}
                      onChange={(e) => setExpiresInHours(e.target.value)}
                      className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                    >
                      <option value="4">4 hours</option>
                      <option value="12">12 hours</option>
                      <option value="24">24 hours</option>
                      <option value="48">2 days</option>
                      <option value="72">3 days</option>
                    </select>
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-secondary">Optional passcode</label>
                    <input
                      type="text"
                      value={passcode}
                      onChange={(e) => setPasscode(e.target.value)}
                      className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                    />
                  </div>
                </div>
                {createError && <p className="text-sm text-critical">{createError}</p>}
                <Button type="submit" loading={creating} disabled={scopes.length === 0 || !label.trim()}>
                  Create day pass
                </Button>
                {newLinkUrl && (
                  <p className="rounded-lg bg-positive-subtle px-3 py-2 text-sm text-positive-subtle-text">
                    {newLinkUrl} — copy this now, it won&apos;t be shown again.
                  </p>
                )}
              </form>
            </CardBody>
          </Card>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">Passes</h2>
            {passes && passes.length === 0 && <EmptyState title="No day passes yet" description="Create one above the next time you need a sitter or house-sitter." />}
            {passes?.map((p) => {
              const status = statusOf(p);
              const active = !p.revokedAt && !p.expiredAt && new Date(p.expiresAt) >= new Date();
              return (
                <Card key={p.id}>
                  <CardBody className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[0.9375rem] font-medium text-primary">{p.label}</p>
                      <p className="text-sm text-tertiary">
                        {p.scopes.join(", ")} — <span className={status.tone === "positive" ? "text-positive-subtle-text" : ""}>{status.text}</span>
                      </p>
                    </div>
                    {active && (
                      <Button variant="secondary" size="sm" onClick={() => revoke(p.id, p.label)}>
                        End now
                      </Button>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </section>
        </>
      )}
    </div>
  );
}
