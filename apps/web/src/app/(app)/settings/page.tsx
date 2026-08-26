"use client";

import { useRouter } from "next/navigation";
import useSWR from "swr";
import { useTheme } from "@/hooks/use-theme";
import { useSession } from "@/hooks/use-session";
import { swrFetcher, api } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";

interface NotificationPreferences {
  intensity: "quiet" | "balanced" | "proactive";
  dailyBriefEnabled: boolean;
  weeklyBriefEnabled: boolean;
}

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

  async function signOut() {
    await api.post("/v1/auth/sign-out");
    await refresh();
    router.push("/sign-in");
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
          </CardBody>
        </Card>
      </section>

      <Button variant="secondary" onClick={signOut}>
        Sign out
      </Button>
    </div>
  );
}
