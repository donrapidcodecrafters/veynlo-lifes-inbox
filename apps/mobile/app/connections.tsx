import { useCallback, useState } from "react";
import { Linking, Platform, Pressable, RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Calendar from "expo-calendar";
import * as Clipboard from "expo-clipboard";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";

const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
};

interface Connection {
  id: string;
  provider: string;
  health: string;
  healthDetail: string | null;
  itemsDiscoveredCount: number;
}

interface InboundAliasInfo {
  configured: boolean;
  address: string | null;
}

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

const AVAILABLE_CONNECTORS = [
  { provider: "gmail", name: "Gmail", description: "Receipts, bills, appointments, and more from your inbox." },
  { provider: "outlook", name: "Outlook", description: "The same, from a Microsoft 365 or Outlook.com inbox." },
  { provider: "google-calendar", name: "Google Calendar", description: "Sync your Google Calendar events directly." },
  { provider: "microsoft-calendar", name: "Microsoft Calendar", description: "Sync your Outlook/Microsoft 365 calendar events directly." },
] as const;

const HISTORY_DEPTH_OPTIONS = [
  { value: "0", label: "New only" },
  { value: "30", label: "30d" },
  { value: "90", label: "90d" },
  { value: "182", label: "6mo" },
  { value: "365", label: "1yr" },
  { value: "3650", label: "All" },
] as const;

export default function ConnectionsScreen() {
  const { theme } = useAppTheme();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [inboundAlias, setInboundAlias] = useState<InboundAliasInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [showIcsForm, setShowIcsForm] = useState(false);
  const [historyDepthDays, setHistoryDepthDays] = useState<(typeof HISTORY_DEPTH_OPTIONS)[number]["value"]>("90");
  const [deviceCalendarSyncing, setDeviceCalendarSyncing] = useState(false);
  const [deviceCalendarMessage, setDeviceCalendarMessage] = useState<string | null>(null);
  const [remindersSyncing, setRemindersSyncing] = useState(false);
  const [remindersMessage, setRemindersMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setConnections(await api.get<Connection[]>("/v1/connectors"));
    setInboundAlias(await api.get<InboundAliasInfo>("/v1/auth/inbound-alias"));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function connect(provider: (typeof AVAILABLE_CONNECTORS)[number]) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(
        `/v1/connectors/${provider.provider}/authorize?historyDepthDays=${historyDepthDays}`,
      );
      // Completes in the system browser, not an in-app deep-link handback — after finishing there, pull to
      // refresh here (or check the web app) to see the new connection. Real deep-link OAuth handback for
      // native is a follow-up (see ROADMAP).
      await Linking.openURL(authorizationUrl);
    } catch (err) {
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? `${provider.name} isn't configured on this deployment yet.`
          : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  async function disconnect(id: string, deleteDerivedData: boolean) {
    await api.post(`/v1/connectors/${id}/disconnect`, { deleteDerivedData });
    setConfirmingDeleteId(null);
    load();
  }

  /**
   * Push-from-client sync (§Connections "Apple local calendar") — there's no OAuth token or feed URL a
   * server could poll for a device's own calendar, so this app reads it directly via expo-calendar and
   * posts what it finds. Manual "Sync now" only, not a background job: real background sync needs
   * TaskManager/BackgroundFetch (its own cross-platform battery/OS-permission complexity), a deliberately
   * separate, larger follow-up rather than something to fold in here.
   */
  async function syncDeviceCalendar() {
    setDeviceCalendarSyncing(true);
    setDeviceCalendarMessage(null);
    try {
      // Named "...Async" in expo-calendar's LEGACY api, but this app imports the plain "expo-calendar"
      // entrypoint, which resolves to the new object-oriented API — that API re-exports the same
      // "...Async"-suffixed names ONLY as deprecated stubs that unconditionally throw at runtime (see
      // expo-calendar's own build/legacyWarnings.js). The unsuffixed names below are the real ones.
      const perm = await Calendar.requestCalendarPermissions();
      if (perm.status !== "granted") {
        setDeviceCalendarMessage("Calendar access is off — enable it in your device settings to sync.");
        return;
      }
      const calendars = await Calendar.getCalendars(Calendar.EntityTypes.EVENT);
      const startDate = new Date(Date.now() - 30 * 86_400_000);
      const endDate = new Date(Date.now() + 365 * 86_400_000);
      const events = await Calendar.listEvents(
        calendars.map((c) => c.id),
        startDate,
        endDate,
      );
      const payloadEvents = events.slice(0, 500).map((e) => ({
        uid: e.id,
        title: e.title || "Untitled event",
        startIso: new Date(e.startDate).toISOString(),
        endIso: e.endDate ? new Date(e.endDate).toISOString() : null,
        isAllDay: Boolean(e.allDay),
        location: e.location || null,
      }));
      if (payloadEvents.length === 0) {
        setDeviceCalendarMessage("No events found in the next year.");
        return;
      }
      const result = await api.post<{ filedCount: number; totalCount: number }>("/v1/ingestion/device-calendar", {
        events: payloadEvents,
      });
      setDeviceCalendarMessage(
        result.filedCount > 0
          ? `Synced — ${result.filedCount} new or updated event${result.filedCount === 1 ? "" : "s"}.`
          : "Synced — everything was already up to date.",
      );
    } catch (err) {
      setDeviceCalendarMessage(err instanceof ApiError ? err.message : "Couldn't sync your calendar. Please try again.");
    } finally {
      setDeviceCalendarSyncing(false);
    }
  }

  /**
   * §Connections "Apple Reminders" — read-only import, mirroring syncDeviceCalendar's push-from-client
   * shape exactly. iOS only: EventKit reminders have no Android equivalent, so this card never renders
   * there (see the Platform.OS check around its <Card> below).
   */
  async function syncReminders() {
    setRemindersSyncing(true);
    setRemindersMessage(null);
    try {
      const perm = await Calendar.requestRemindersPermissions();
      if (perm.status !== "granted") {
        setRemindersMessage("Reminders access is off — enable it in your device settings to sync.");
        return;
      }
      const calendars = await Calendar.getCalendars(Calendar.EntityTypes.REMINDER);
      const startDate = new Date(Date.now() - 30 * 86_400_000);
      const endDate = new Date(Date.now() + 365 * 86_400_000);
      const allReminders = (
        await Promise.all(calendars.map((c) => c.listReminders(startDate, endDate, null)))
      ).flat();
      const payloadReminders = allReminders
        .filter((r) => Boolean(r.id))
        .slice(0, 500)
        .map((r) => ({
          uid: r.id!,
          title: r.title || "Untitled reminder",
          dueIso: r.dueDate ? new Date(r.dueDate).toISOString() : null,
          notes: r.notes || null,
          completed: Boolean(r.completed),
        }));
      if (payloadReminders.length === 0) {
        setRemindersMessage("No reminders found in the next year.");
        return;
      }
      const result = await api.post<{ filedCount: number; totalCount: number }>("/v1/ingestion/device-reminders", {
        reminders: payloadReminders,
      });
      setRemindersMessage(
        result.filedCount > 0
          ? `Synced — ${result.filedCount} new or updated reminder${result.filedCount === 1 ? "" : "s"}.`
          : "Synced — everything was already up to date.",
      );
    } catch (err) {
      setRemindersMessage(err instanceof ApiError ? err.message : "Couldn't sync your reminders. Please try again.");
    } finally {
      setRemindersSyncing(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Connections" subtitle="Veynlo only reads what you connect, and you can disconnect or delete it at any time." />

      {connectError && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 13 }}>{connectError}</Text>
        </View>
      )}

      <Card style={{ gap: 8 }}>
        <View>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>History to import</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            How far back to look when you connect email or calendar below.
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.sm }}>
          {HISTORY_DEPTH_OPTIONS.map((opt) => {
            const active = historyDepthDays === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setHistoryDepthDays(opt.value)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: theme.radius.sm,
                  backgroundColor: active ? theme.colors.bgSurface : "transparent",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <View style={{ gap: 8 }}>
        {AVAILABLE_CONNECTORS.map((provider) => (
          <Card key={provider.provider} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{provider.name}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{provider.description}</Text>
            </View>
            <Button variant="secondary" onPress={() => connect(provider)}>
              Connect
            </Button>
          </Card>
        ))}

        <Card style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Calendar feed (ICS)</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Subscribe to a school, team, or shared calendar's .ics link.
              </Text>
            </View>
            {!showIcsForm && (
              <Button variant="secondary" onPress={() => setShowIcsForm(true)}>
                Add feed
              </Button>
            )}
          </View>
          {showIcsForm && (
            <IcsConnectForm
              onDone={() => {
                setShowIcsForm(false);
                load();
              }}
              onCancel={() => setShowIcsForm(false)}
            />
          )}
        </Card>

        <Card style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>This phone's calendar</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Sync events from your device's own Calendar app. Manual sync — pull down to run it again.
              </Text>
            </View>
            <Button variant="secondary" onPress={syncDeviceCalendar} loading={deviceCalendarSyncing}>
              Sync now
            </Button>
          </View>
          {deviceCalendarMessage && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{deviceCalendarMessage}</Text>}
        </Card>

        {Platform.OS === "ios" && (
          <Card style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Apple Reminders</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                  Sync your Reminders app tasks. Manual sync — pull down to run it again.
                </Text>
              </View>
              <Button variant="secondary" onPress={syncReminders} loading={remindersSyncing}>
                Sync now
              </Button>
            </View>
            {remindersMessage && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{remindersMessage}</Text>}
          </Card>
        )}

        <Card style={{ gap: 10 }}>
          <View>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Forward emails to Veynlo</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              Forward a receipt, itinerary, or notice to your own Veynlo address — no account access needed.
            </Text>
          </View>
          {!inboundAlias && <View style={{ height: 36, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md }} />}
          {inboundAlias && !inboundAlias.configured && (
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Email forwarding isn&apos;t configured on this deployment yet.</Text>
          )}
          {inboundAlias?.configured && inboundAlias.address && (
            <ForwardingAddress address={inboundAlias.address} onRotate={load} />
          )}
        </Card>
      </View>

      {!connections && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {connections?.length === 0 && (
        <EmptyState title="No connections yet" description="Connect your email above to start finding useful things automatically." />
      )}

      {connections && connections.length > 0 && (
        <View style={{ gap: 8 }}>
          {connections.map((c) => (
            <Card key={c.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                    {PROVIDER_LABEL[c.provider] ?? c.provider}
                  </Text>
                  <Badge tone={HEALTH_TONE[c.health] ?? "neutral"}>{c.health.replace(/_/g, " ")}</Badge>
                </View>
                {confirmingDeleteId !== c.id && (
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    <Button variant="ghost" onPress={() => disconnect(c.id, false)}>
                      Disconnect
                    </Button>
                    <Button variant="ghost" onPress={() => setConfirmingDeleteId(c.id)}>
                      Delete data
                    </Button>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{c.itemsDiscoveredCount} items discovered</Text>
              {c.healthDetail && <Text style={{ fontSize: 12, color: theme.colors.warningSubtleText }}>{c.healthDetail}</Text>}
              {confirmingDeleteId === c.id && (
                <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
                    This permanently deletes the purchases, bills, appointments, and other items found via this connection. It
                    can&apos;t be undone.
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button onPress={() => disconnect(c.id, true)}>Confirm delete</Button>
                    <Button variant="ghost" onPress={() => setConfirmingDeleteId(null)}>
                      Cancel
                    </Button>
                  </View>
                </View>
              )}
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}

function IcsConnectForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { theme } = useAppTheme();
  const [url, setUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [basicAuthUsername, setBasicAuthUsername] = useState("");
  const [basicAuthPassword, setBasicAuthPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/connectors/ics/connect", {
        url,
        feedName: feedName || undefined,
        basicAuthUsername: showAuth && basicAuthUsername ? basicAuthUsername : undefined,
        basicAuthPassword: showAuth && basicAuthPassword ? basicAuthPassword : undefined,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <View style={{ gap: 10 }}>
      <TextField
        label="Calendar feed URL"
        placeholder="https://example.com/calendar.ics"
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        keyboardType="url"
      />
      <TextField label="Name (optional)" placeholder="e.g. Kid's soccer schedule" value={feedName} onChangeText={setFeedName} />
      {!showAuth ? (
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setShowAuth(true)}>
          This feed needs a username and password
        </Text>
      ) : (
        <>
          <TextField label="Username" value={basicAuthUsername} onChangeText={setBasicAuthUsername} autoCapitalize="none" />
          <TextField label="Password" value={basicAuthPassword} onChangeText={setBasicAuthPassword} secureTextEntry autoCapitalize="none" />
        </>
      )}
      {error && <Text style={{ color: theme.colors.critical, fontSize: 13 }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={onSubmit} loading={submitting} disabled={!url}>
            Add feed
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={onCancel}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}

function ForwardingAddress({ address, onRotate }: { address: string; onRotate: () => void }) {
  const { theme } = useAppTheme();
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  async function copy() {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function rotate() {
    setRotating(true);
    try {
      await api.post("/v1/auth/inbound-alias/rotate");
      onRotate();
    } finally {
      setRotating(false);
      setConfirmingRotate(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ flex: 1, fontSize: 13, color: theme.colors.textPrimary, fontFamily: "monospace" }}>{address}</Text>
        <Button variant="secondary" onPress={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </View>
      {!confirmingRotate ? (
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setConfirmingRotate(true)}>
          Generate a new address
        </Text>
      ) : (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.warningSubtleText }}>
            The current address will stop working immediately. Update anywhere you&apos;ve saved it.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button onPress={rotate} loading={rotating}>
              Confirm
            </Button>
            <Button variant="ghost" onPress={() => setConfirmingRotate(false)}>
              Cancel
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}
