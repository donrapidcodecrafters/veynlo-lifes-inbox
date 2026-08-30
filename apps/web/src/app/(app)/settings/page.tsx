"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import { useTheme } from "@/hooks/use-theme";
import { useSession } from "@/hooks/use-session";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

type PrivacyLevel = "full" | "hide_amounts" | "hide_titles" | "generic";

interface NotificationPreferences {
  intensity: "quiet" | "balanced" | "proactive";
  dailyBriefEnabled: boolean;
  weeklyBriefEnabled: boolean;
  categoryOverrides: Record<string, string>;
  privacyLevel: PrivacyLevel;
}

// Matches the real `category` values IngestionService.fileInboxItem passes when filing each domain
// (see the `domains.includes(...)` branches in ingestion.service.ts) — the only categories a user
// could plausibly want to mute individually. Digests have their own dedicated toggles above instead.
const NOTIFICATION_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "purchase", label: "Purchases" },
  { key: "shipment", label: "Shipments" },
  { key: "bill", label: "Bills" },
  { key: "subscription", label: "Subscriptions" },
  { key: "appointment", label: "Appointments" },
  { key: "warranty", label: "Warranties" },
  { key: "task", label: "Tasks" },
];

// Cumulative lock-screen privacy ladder — each level hides everything the previous one hides, plus more.
// Matches services/api/src/modules/notifications/notification-privacy.ts's applyPrivacyLevel exactly.
const PRIVACY_LEVELS: Array<{ value: PrivacyLevel; label: string; description: string }> = [
  { value: "full", label: "Full", description: "Lock screen shows the real title and message." },
  { value: "hide_amounts", label: "Hide amounts", description: "Same as Full, but dollar amounts are hidden." },
  { value: "hide_titles", label: "Hide titles", description: "Hides amounts, and replaces the title with a generic category label." },
  { value: "generic", label: "Generic", description: "Lock screen shows only \"Veynlo\" — nothing about what it's about." },
];

export default function SettingsPage() {
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const { user, refresh } = useSession();
  const { data: prefs, mutate } = useSWR<NotificationPreferences>("/v1/notification-preferences", swrFetcher);

  async function updatePrefs(patch: Partial<NotificationPreferences>) {
    mutate({ ...prefs, ...patch } as NotificationPreferences, false);
    await api.put("/v1/notification-preferences", patch);
    mutate();
  }

  async function setCategoryMuted(category: string, muted: boolean) {
    const categoryOverrides = { ...(prefs?.categoryOverrides ?? {}) };
    if (muted) categoryOverrides[category] = "off";
    else delete categoryOverrides[category];
    await updatePrefs({ categoryOverrides });
  }

  async function signOut() {
    await api.post("/v1/auth/sign-out");
    await refresh();
    router.push("/sign-in");
  }

  const [showDeleteForm, setShowDeleteForm] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.post("/v1/auth/delete-account", user?.hasPassword ? { password: deletePassword } : {});
      await refresh();
      router.push("/sign-in");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Settings</h1>
      </header>

      <Card>
        <CardBody className="space-y-1">
          <p className="text-[0.9375rem] font-medium text-primary">{user?.displayName}</p>
          <p className="text-sm text-tertiary">{user?.email}</p>
        </CardBody>
      </Card>

      <section>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Privacy</p>
              <p className="text-sm text-tertiary">What Veynlo can see, AI processing, and your data controls — all in one place.</p>
            </div>
            <Link href="/settings/privacy">
              <Button variant="secondary">Open</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Devices &amp; sessions</p>
              <p className="text-sm text-tertiary">See everywhere you're signed in, and sign out of any device remotely.</p>
            </div>
            <Link href="/settings/sessions">
              <Button variant="secondary">Open</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Appearance</h2>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Theme</p>
              <p className="text-sm text-tertiary">Follow system, or choose light or dark.</p>
            </div>
            <SegmentedControl
              aria-label="Theme"
              value={mode}
              onChange={setMode}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Billing</h2>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Plan &amp; billing</p>
              <p className="text-sm text-tertiary">Manage your subscription and see what&apos;s included.</p>
            </div>
            <Link href="/settings/billing">
              <Button variant="secondary">Manage</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Notifications</h2>
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-[0.9375rem] font-medium text-primary">Intensity</p>
              <SegmentedControl
                aria-label="Notification intensity"
                value={prefs?.intensity ?? "balanced"}
                onChange={(v) => updatePrefs({ intensity: v })}
                options={[
                  { value: "quiet", label: "Quiet" },
                  { value: "balanced", label: "Balanced" },
                  { value: "proactive", label: "Proactive" },
                ]}
              />
            </div>
            <div className="space-y-2 border-t border-border-subtle pt-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-[0.9375rem] font-medium text-primary">Lock screen privacy</p>
                <SegmentedControl
                  aria-label="Lock screen privacy level"
                  value={prefs?.privacyLevel ?? "full"}
                  onChange={(v) => updatePrefs({ privacyLevel: v })}
                  options={PRIVACY_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
                />
              </div>
              <p className="text-sm text-tertiary">
                {PRIVACY_LEVELS.find((l) => l.value === (prefs?.privacyLevel ?? "full"))?.description}
              </p>
            </div>
            <Switch
              id="daily-brief"
              label="Daily brief"
              description="A short summary each morning."
              checked={prefs?.dailyBriefEnabled ?? true}
              onCheckedChange={(v) => updatePrefs({ dailyBriefEnabled: v })}
            />
            <Switch
              id="weekly-brief"
              label="Weekly brief"
              description="What's coming up next week."
              checked={prefs?.weeklyBriefEnabled ?? true}
              onCheckedChange={(v) => updatePrefs({ weeklyBriefEnabled: v })}
            />
            <div className="space-y-3 border-t border-border-subtle pt-4">
              <p className="text-[0.9375rem] font-medium text-primary">By category</p>
              <p className="text-sm text-tertiary">Turn off notifications for a specific kind of thing without changing your overall intensity.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {NOTIFICATION_CATEGORIES.map((c) => (
                  <Switch
                    key={c.key}
                    id={`category-${c.key}`}
                    label={c.label}
                    checked={prefs?.categoryOverrides?.[c.key] !== "off"}
                    onCheckedChange={(v) => setCategoryMuted(c.key, !v)}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle pt-4">
              <p className="text-sm text-tertiary">See everything Veynlo has sent you.</p>
              <Link href="/settings/notifications">
                <Button variant="secondary" size="sm">
                  View history
                </Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Your data</h2>
        <div className="space-y-3">
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Household</p>
                <p className="text-sm text-tertiary">Invite family members, add dependents, and grant caregiver access.</p>
              </div>
              <Link href="/household">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Connections</p>
                <p className="text-sm text-tertiary">Manage what Veynlo reads from — email, calendars, and feeds.</p>
              </div>
              <Link href="/connections">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Shared links</p>
                <p className="text-sm text-tertiary">See and revoke everything you've shared via a link.</p>
              </div>
              <Link href="/settings/shared">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
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
        </div>
      </section>

      <Button variant="secondary" onClick={signOut}>
        Sign out
      </Button>

      <section id="danger-zone">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Danger zone</h2>
        <Card>
          <CardBody className="space-y-4">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Delete account</p>
              <p className="text-sm text-tertiary">
                Permanently deletes your account and everything in it. This can&apos;t be undone.
              </p>
            </div>
            {!showDeleteForm ? (
              <Button variant="critical" onClick={() => setShowDeleteForm(true)}>
                Delete account
              </Button>
            ) : (
              <form onSubmit={deleteAccount} className="space-y-4" noValidate>
                {user?.hasPassword ? (
                  <div>
                    <Label htmlFor="delete-password">Confirm your password</Label>
                    <Input
                      id="delete-password"
                      type="password"
                      autoComplete="current-password"
                      value={deletePassword}
                      onChange={(e) => setDeletePassword(e.target.value)}
                      required
                    />
                  </div>
                ) : (
                  <p className="text-sm text-tertiary">
                    Your account uses Google/Microsoft sign-in with no separate password — confirming here is enough.
                  </p>
                )}
                {deleteError && (
                  <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
                    {deleteError}
                  </p>
                )}
                <div className="flex gap-3">
                  <Button type="submit" variant="critical" loading={deleting}>
                    Permanently delete my account
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setShowDeleteForm(false);
                      setDeletePassword("");
                      setDeleteError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
