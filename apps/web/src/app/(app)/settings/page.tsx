"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import { useTranslations } from "next-intl";
import { useTheme } from "@/hooks/use-theme";
import { useSession } from "@/hooks/use-session";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

interface NotificationPreferences {
  intensity: "quiet" | "balanced" | "proactive";
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  criticalOverridesQuietHours: boolean;
  dailyBriefEnabled: boolean;
  weeklyBriefEnabled: boolean;
  sensitivePreviewsEnabled: boolean;
}

export default function SettingsPage() {
  const router = useRouter();
  const t = useTranslations("settings");
  const { mode, setMode } = useTheme();
  const { user, refresh } = useSession();
  const { data: prefs, mutate } = useSWR<NotificationPreferences>("/v1/notification-preferences", swrFetcher);

  async function updatePrefs(patch: Partial<NotificationPreferences>) {
    mutate({ ...prefs, ...patch } as NotificationPreferences, false);
    await api.put("/v1/notification-preferences", patch);
    mutate();
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
      await api.post("/v1/auth/delete-account", { password: deletePassword });
      await refresh();
      router.push("/sign-in");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : t("deleteAccount.genericError"));
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">{t("title")}</h1>
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
              <p className="text-[0.9375rem] font-medium text-primary">{t("privacy.title")}</p>
              <p className="text-sm text-tertiary">{t("privacy.description")}</p>
            </div>
            <Link href="/settings/privacy">
              <Button variant="secondary">{t("privacy.open")}</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">{t("security.title")}</p>
              <p className="text-sm text-tertiary">{t("security.description")}</p>
            </div>
            <Link href="/settings/security">
              <Button variant="secondary">{t("security.open")}</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">{t("household.title")}</p>
              <p className="text-sm text-tertiary">{t("household.description")}</p>
            </div>
            <Link href="/settings/household">
              <Button variant="secondary">{t("household.open")}</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">{t("personalization.title")}</p>
              <p className="text-sm text-tertiary">{t("personalization.description")}</p>
            </div>
            <Link href="/settings/personalization">
              <Button variant="secondary">{t("personalization.open")}</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{t("sections.appearance")}</h2>
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
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{t("sections.billing")}</h2>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">{t("billing.title")}</p>
              <p className="text-sm text-tertiary">{t("billing.description")}</p>
            </div>
            <Link href="/settings/billing">
              <Button variant="secondary">{t("billing.manage")}</Button>
            </Link>
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{t("sections.notifications")}</h2>
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
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border-subtle pt-4">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Quiet hours</p>
                <p className="text-sm text-tertiary">No non-critical notifications during this window, in your local time.</p>
              </div>
              {/*
                Bug fix: found live at 390px — `type="time"` inputs have a browser-intrinsic minimum
                width (~130px here) that `w-auto` correctly lets them keep (see cn.ts's own doc comment:
                twMerge now makes a caller's override reliably win over Input's base `w-full`). Two of
                them plus the "to" label need ~290px, but this row is a plain non-wrapping flex
                `justify-between` against a label column that doesn't shrink — at mobile width the two
                sit in whatever space is left over and the second input's right edge lands ~30px past the
                viewport (confirmed via getBoundingClientRect: input.right 423 vs window.innerWidth 390).
                `flex-wrap` here lets the input pair drop to its own row under the label once they no
                longer fit side by side, instead of overflowing it.
              */}
              <div className="flex items-center gap-2">
                <Input
                  type="time"
                  aria-label="Quiet hours start"
                  className="w-auto"
                  value={prefs?.quietHoursStart ?? ""}
                  onChange={(e) => updatePrefs({ quietHoursStart: e.target.value || null })}
                />
                <span className="text-sm text-tertiary">to</span>
                <Input
                  type="time"
                  aria-label="Quiet hours end"
                  className="w-auto"
                  value={prefs?.quietHoursEnd ?? ""}
                  onChange={(e) => updatePrefs({ quietHoursEnd: e.target.value || null })}
                />
              </div>
            </div>
            <Switch
              id="critical-overrides-quiet-hours"
              label="Let critical alerts break through quiet hours"
              description="A severe, time-sensitive issue (e.g. a confirmed flight cancellation or identity/insurance expiration) can still notify you during quiet hours. Off means nothing does."
              checked={prefs?.criticalOverridesQuietHours ?? true}
              onCheckedChange={(v) => updatePrefs({ criticalOverridesQuietHours: v })}
            />
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
            <Switch
              id="sensitive-previews"
              label="Show details in notifications"
              description="When off, notifications say something needs attention without the specific amounts, dates, or descriptions — open Veynlo to see them."
              checked={prefs?.sensitivePreviewsEnabled ?? true}
              onCheckedChange={(v) => updatePrefs({ sensitivePreviewsEnabled: v })}
            />
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

      {/* §38.2 "Internationalization" — this page's header, section headings, and top four cards
          (Privacy/Security/Household/Personalization) are wired to i18n/messages/en.json as the
          representative slice for this screen; the individual "Your data" row titles/descriptions
          below are deliberately left as literals for now (see this app's i18n/provider.tsx doc
          comment / the root README's "Internationalization" section for why a full sweep of every
          string wasn't done in this pass) — extending this section is the same t("settings.<key>")
          pattern already used above. */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{t("sections.yourData")}</h2>
        <div className="space-y-3">
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
                <p className="text-[0.9375rem] font-medium text-primary">What Veynlo knows</p>
                <p className="text-sm text-tertiary">Items and warranties Veynlo has identified from your purchases and documents.</p>
              </div>
              <Link href="/entities">
                <Button variant="secondary">View</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Automations</p>
                <p className="text-sm text-tertiary">Rules that notify you or add a task when something happens.</p>
              </div>
              <Link href="/automations">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Trusted reschedule senders</p>
                <p className="text-sm text-tertiary">Senders whose reschedule emails apply automatically instead of being offered for review.</p>
              </div>
              <Link href="/settings/calendar-trust">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Sender rules</p>
                <p className="text-sm text-tertiary">Teach Veynlo once: always file a sender as School/Bills, ignore it, keep only attachments, or mark it household-shared.</p>
              </div>
              <Link href="/settings/sender-rules">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Lists</p>
                <p className="text-sm text-tertiary">Groceries, packing, gifts, and other shared or private lists.</p>
              </div>
              <Link href="/lists">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Saved places</p>
                <p className="text-sm text-tertiary">Home, work, family — set up an arrival/departure reminder from the mobile app.</p>
              </div>
              <Link href="/places">
                <Button variant="secondary">Manage</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Emergency binder</p>
                <p className="text-sm text-tertiary">Household roster, vehicles, property, and medical info in one password-protected place.</p>
              </div>
              <Link href="/emergency-binder">
                <Button variant="secondary">Open</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Sharing</p>
                <p className="text-sm text-tertiary">Everything you&apos;ve shared out, what&apos;s shared with you, caregiver day passes, and legacy release.</p>
              </div>
              <Link href="/settings/sharing">
                <Button variant="secondary">Open</Button>
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
        {t("signOut")}
      </Button>

      <section id="danger-zone">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{t("sections.dangerZone")}</h2>
        <Card>
          <CardBody className="space-y-4">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">{t("deleteAccount.title")}</p>
              <p className="text-sm text-tertiary">{t("deleteAccount.description")}</p>
            </div>
            {!showDeleteForm ? (
              <Button variant="critical" onClick={() => setShowDeleteForm(true)}>
                {t("deleteAccount.cta")}
              </Button>
            ) : (
              <form onSubmit={deleteAccount} className="space-y-4" noValidate>
                <p className="text-sm text-tertiary">{t("deleteAccount.confirmNotice")}</p>
                <div>
                  <Label htmlFor="delete-password">{t("deleteAccount.confirmPasswordLabel")}</Label>
                  <Input
                    id="delete-password"
                    type="password"
                    autoComplete="current-password"
                    value={deletePassword}
                    onChange={(e) => setDeletePassword(e.target.value)}
                    required
                  />
                </div>
                {deleteError && (
                  <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
                    {deleteError}
                  </p>
                )}
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button type="submit" variant="critical" loading={deleting} className="whitespace-nowrap">
                    {t("deleteAccount.submit")}
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
                    {t("deleteAccount.cancel")}
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
