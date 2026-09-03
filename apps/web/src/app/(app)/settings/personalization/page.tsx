"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { CATEGORY_DOMAIN_KEYS, type CategoryDomainKey } from "@veynlo/core";
import { swrFetcher, api } from "@/lib/api-client";
import { usePersonalizationPreferences } from "@/hooks/use-personalization";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Input, Label } from "@/components/ui/input";

// PERS-002 "Home customization" — same fixed module-key set as apps/web's home/page.tsx (see that file's
// own OPTIONAL_MODULE_KEYS doc comment for why "needs_you" is never one of these).
const OPTIONAL_MODULE_KEYS = ["today", "money_at_risk", "family_today"] as const;
type OptionalModuleKey = (typeof OPTIONAL_MODULE_KEYS)[number];
const MODULE_LABELS: Record<OptionalModuleKey, string> = {
  today: "Today",
  money_at_risk: "Money at risk & savings",
  family_today: "Household — Today",
};

interface HomeModulePreferences {
  moduleOrder: string[];
  hiddenModules: string[];
}

function resolveModuleOrder(prefs: HomeModulePreferences | undefined): OptionalModuleKey[] {
  const stored = (prefs?.moduleOrder ?? []).filter((k): k is OptionalModuleKey => (OPTIONAL_MODULE_KEYS as readonly string[]).includes(k));
  const missing = OPTIONAL_MODULE_KEYS.filter((k) => !stored.includes(k));
  return [...stored, ...missing];
}

interface CategoryPreference {
  domain: CategoryDomainKey;
  label: string;
  disableExplanation: string;
  enabled: boolean;
}

export default function PersonalizationSettingsPage() {
  const { data: modulePrefs, mutate: mutateModulePrefs } = useSWR<HomeModulePreferences>("/v1/home-module-preferences", swrFetcher);
  const { data: categoryPrefs, mutate: mutateCategoryPrefs } = useSWR<CategoryPreference[]>("/v1/category-preferences", swrFetcher);
  const { data: personalization, mutate: mutatePersonalization } = usePersonalizationPreferences();
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);

  const moduleOrder = resolveModuleOrder(modulePrefs);
  const hiddenModules = new Set(modulePrefs?.hiddenModules ?? []);

  async function saveHomeModulePreferences(nextOrder: OptionalModuleKey[], nextHidden: Set<string>) {
    const patch = { moduleOrder: nextOrder, hiddenModules: [...nextHidden] };
    mutateModulePrefs({ moduleOrder: nextOrder, hiddenModules: [...nextHidden] }, false);
    await api.put("/v1/home-module-preferences", patch);
    mutateModulePrefs();
  }

  function moveModule(key: OptionalModuleKey, direction: -1 | 1) {
    const index = moduleOrder.indexOf(key);
    const swapWith = index + direction;
    if (swapWith < 0 || swapWith >= moduleOrder.length) return;
    const next = [...moduleOrder];
    [next[index], next[swapWith]] = [next[swapWith]!, next[index]!];
    saveHomeModulePreferences(next, hiddenModules);
  }

  function toggleModuleHidden(key: OptionalModuleKey, hidden: boolean) {
    const next = new Set(hiddenModules);
    if (hidden) next.add(key);
    else next.delete(key);
    saveHomeModulePreferences(moduleOrder, next);
  }

  async function toggleCategory(domain: CategoryDomainKey, enabled: boolean) {
    mutateCategoryPrefs((prev) => prev?.map((c) => (c.domain === domain ? { ...c, enabled } : c)), false);
    await api.put("/v1/category-preferences", { domain, enabled });
    mutateCategoryPrefs();
  }

  async function saveName(e: FormEvent) {
    e.preventDefault();
    setSavingName(true);
    try {
      const updated = await api.put<{ preferredName: string | null }>("/v1/personalization-preferences", { preferredName: nameDraft });
      mutatePersonalization({ ...personalization, preferredName: updated.preferredName }, false);
      setNameDraft(null);
    } finally {
      setSavingName(false);
    }
  }

  async function updatePersonalization(patch: Partial<typeof personalization>) {
    mutatePersonalization({ ...personalization, ...patch }, false);
    await api.put("/v1/personalization-preferences", patch);
    mutatePersonalization();
  }

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Personalization</h1>
        <p className="mt-1 text-sm text-tertiary">Home layout, what Veynlo pays attention to, naming, and how Ask responds.</p>
      </header>

      {/* PERS-002 Home customization */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Home layout</h2>
        <Card>
          <CardBody className="space-y-1">
            <p className="mb-2 text-sm text-tertiary">
              Reorder or hide the sections below Needs You. Needs You always stays first and can&apos;t be hidden — it&apos;s where
              anything that genuinely needs your attention shows up.
            </p>
            {moduleOrder.map((key, index) => (
              <div key={key} className="flex items-center justify-between gap-3 border-t border-border-subtle py-3 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${MODULE_LABELS[key]} up`}
                      disabled={index === 0}
                      onClick={() => moveModule(key, -1)}
                      className="px-1 text-tertiary hover:text-primary disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${MODULE_LABELS[key]} down`}
                      disabled={index === moduleOrder.length - 1}
                      onClick={() => moveModule(key, 1)}
                      className="px-1 text-tertiary hover:text-primary disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </div>
                  <p className="text-[0.9375rem] font-medium text-primary">{MODULE_LABELS[key]}</p>
                </div>
                <Switch
                  id={`module-visible-${key}`}
                  label="Show on Home"
                  checked={!hiddenModules.has(key)}
                  onCheckedChange={(shown) => toggleModuleHidden(key, !shown)}
                />
              </div>
            ))}
          </CardBody>
        </Card>
      </section>

      {/* PERS-003 Category preferences */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">What Veynlo pays attention to</h2>
        <Card>
          <CardBody className="space-y-1">
            <p className="mb-2 text-sm text-tertiary">
              Turn off a category to stop Veynlo from detecting new items in it. Anything already saved stays exactly as it is.
            </p>
            {(categoryPrefs ?? CATEGORY_DOMAIN_KEYS.map((domain) => ({ domain, label: domain, disableExplanation: "", enabled: true }))).map((cat) => (
              <div key={cat.domain} className="border-t border-border-subtle py-3 first:border-t-0 first:pt-0">
                <Switch
                  id={`category-${cat.domain}`}
                  label={cat.label}
                  description={!cat.enabled ? cat.disableExplanation : undefined}
                  checked={cat.enabled}
                  onCheckedChange={(enabled) => toggleCategory(cat.domain, enabled)}
                />
              </div>
            ))}
          </CardBody>
        </Card>
      </section>

      {/* PERS-004 Naming and language */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Naming and language</h2>
        <Card>
          <CardBody className="space-y-4">
            <form onSubmit={saveName} className="flex flex-wrap items-end gap-3" noValidate>
              <div className="min-w-[200px] flex-1">
                <Label htmlFor="preferred-name">Preferred name</Label>
                <Input
                  id="preferred-name"
                  placeholder="What should Veynlo call you?"
                  value={nameDraft ?? personalization.preferredName ?? ""}
                  onChange={(e) => setNameDraft(e.target.value)}
                />
              </div>
              <Button type="submit" variant="secondary" loading={savingName}>
                Save
              </Button>
            </form>
            <p className="text-xs text-tertiary">
              Used by Ask and notifications instead of your account name. Object nicknames (e.g. renaming &quot;2015 Honda
              Civic&quot; to &quot;Mom&apos;s car&quot;) are set from that item&apos;s own page — vehicles, property, and pets each have their
              own editable label.
            </p>
            <div className="flex items-center justify-between border-t border-border-subtle pt-4">
              <p className="text-[0.9375rem] font-medium text-primary">Week starts on</p>
              <SegmentedControl
                aria-label="Week start"
                value={personalization.weekStart}
                onChange={(v) => updatePersonalization({ weekStart: v })}
                options={[
                  { value: "sunday", label: "Sunday" },
                  { value: "monday", label: "Monday" },
                ]}
              />
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle pt-4">
              <p className="text-[0.9375rem] font-medium text-primary">Time format</p>
              <SegmentedControl
                aria-label="Time format"
                value={personalization.timeFormat}
                onChange={(v) => updatePersonalization({ timeFormat: v })}
                options={[
                  { value: "12h", label: "12-hour" },
                  { value: "24h", label: "24-hour" },
                ]}
              />
            </div>
          </CardBody>
        </Card>
      </section>

      {/* PERS-005 AI tone/verbosity */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Ask</h2>
        <Card>
          <CardBody className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Answer style</p>
                <p className="text-sm text-tertiary">Concise or detailed answers. Never changes what Ask is willing to say or how sure it is.</p>
              </div>
              <SegmentedControl
                aria-label="Ask answer style"
                value={personalization.askResponseStyle}
                onChange={(v) => updatePersonalization({ askResponseStyle: v })}
                options={[
                  { value: "concise", label: "Concise" },
                  { value: "balanced", label: "Balanced" },
                  { value: "detailed", label: "Detailed" },
                ]}
              />
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle pt-4">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Proactive suggestions</p>
                <p className="text-sm text-tertiary">How often Veynlo surfaces suggestions on its own, beyond what you ask about directly.</p>
              </div>
              <SegmentedControl
                aria-label="Suggestion intensity"
                value={personalization.suggestionIntensity}
                onChange={(v) => updatePersonalization({ suggestionIntensity: v })}
                options={[
                  { value: "quiet", label: "Quiet" },
                  { value: "balanced", label: "Balanced" },
                  { value: "proactive", label: "Proactive" },
                ]}
              />
            </div>
          </CardBody>
        </Card>
      </section>
    </div>
  );
}
