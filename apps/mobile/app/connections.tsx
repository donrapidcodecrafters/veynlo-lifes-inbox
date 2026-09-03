import { useCallback, useEffect, useState } from "react";
import { Linking, Platform, RefreshControl, Switch, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams, useRootNavigationState } from "expo-router";
import * as Calendar from "expo-calendar";
import * as Clipboard from "expo-clipboard";
import { api, ApiError } from "@/lib/api-client";
import { openPlaidLink, plaidLinkAvailable } from "@/lib/plaid-link";
import { useAppTheme } from "@/lib/theme-context";
import { useActiveFormattingLocale } from "@/lib/use-active-locale";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";

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
  google_contacts: "Google Contacts",
  microsoft_contacts: "Microsoft Contacts",
  // Mirrors the same fix on apps/web's connections page — missing here left a connected Plaid connection
  // falling through to the raw provider string "plaid" instead of a real display name.
  plaid: "Bank accounts",
};

const CONNECT_ERROR_MESSAGE: Record<string, string> = {
  connector_not_configured: "That connector isn't configured on this deployment yet.",
  invalid_oauth_state: "That connection attempt expired or was invalid. Please try again.",
  connector_failed: "Couldn't complete that connection. Please try again.",
};

// FIN-005 — absent (null) for the common case of a non-liability account; mirrors apps/web's identical shape.
interface FinancialLiability {
  minimumPaymentMinorUnits: number | null;
  dueDate: string | null;
  aprBasisPoints: number | null;
}

interface FinancialAccount {
  id: string;
  name: string;
  mask: string | null;
  currentBalanceMinorUnits: number | null;
  currency: string;
  // FIN-001 "account list allows per-account inclusion/exclusion"
  isIncluded: boolean;
  liability: FinancialLiability | null;
}

interface FinancialTransaction {
  id: string;
  name: string;
  merchantName: string | null;
  amountMinorUnits: number;
  currency: string;
  pending: boolean;
  matchedPurchaseId: string | null;
  matchedBillId: string | null;
}

interface FinanceSummary {
  includedAccountCount: number;
  excludedAccountCount: number;
  totalsByCurrency: Array<{ currency: string; totalMinorUnits: number }>;
}

interface IncomeStream {
  id: string;
  description: string;
  cadenceLabel: string;
  averageAmountMinorUnits: number;
  currency: string;
}

// §38.2 "Currency: store amount + ISO currency" — `locale` defaults to `undefined` (device default)
// rather than a hardcoded "en-US" (mirrors apps/web's identical fix on its own Connections page's
// formatMoney); callers pass the resolved active locale from `useActiveFormattingLocale()`.
function formatMoney(minorUnits: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minorUnits / 100);
}

// FIN-002 "preserve provider transaction ID history and transaction revisions" — mirrors apps/web's
// identical connections-page disclosure (see that file's own TransactionHistoryDisclosure doc comment).
interface TransactionRevision {
  id: string;
  amountMinorUnits: number;
  pending: boolean;
  postedDate: string | null;
  plaidTransactionId: string;
  reason: "pending_amount_changed" | "id_mutated" | "removed";
  createdAt: string;
}

const REVISION_REASON_LABEL: Record<TransactionRevision["reason"], string> = {
  pending_amount_changed: "Amount changed before posting",
  id_mutated: "Replaced by a new provider transaction",
  removed: "Removed by the bank",
};

function TransactionHistoryDisclosure({ transactionId, currency }: { transactionId: string; currency: string }) {
  const { theme } = useAppTheme();
  const locale = useActiveFormattingLocale();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<TransactionRevision[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (revisions === null) {
      setLoading(true);
      setError(null);
      api
        .get<TransactionRevision[]>(`/v1/finance/transactions/${transactionId}/revisions`)
        .then(setRevisions)
        .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load history."))
        .finally(() => setLoading(false));
    }
  }

  return (
    <View>
      <Text accessibilityRole="button" onPress={toggle} style={{ fontSize: 11, fontWeight: "600", color: theme.colors.brandDefault }}>
        {open ? "Hide history" : "History"}
      </Text>
      {open && (
        <View style={{ gap: 2, marginTop: 2, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: theme.colors.borderDefault }}>
          {loading && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Loading…</Text>}
          {error && <Text style={{ fontSize: 11, color: theme.colors.critical }}>{error}</Text>}
          {revisions?.length === 0 && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>No prior revisions.</Text>}
          {revisions?.map((r) => (
            <Text key={r.id} style={{ fontSize: 11, color: theme.colors.textTertiary }}>
              {REVISION_REASON_LABEL[r.reason]}: was {formatMoney(r.amountMinorUnits, currency, locale)}
              {r.pending ? " (pending)" : ""} on {new Date(r.createdAt).toLocaleDateString(locale)}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

interface Connection {
  id: string;
  provider: string;
  health: string;
  healthDetail: string | null;
  itemsDiscoveredCount: number;
  writeBackEnabled: boolean;
  // PRIV-001 "per-source AI-processing toggle" — null means "inherit the account-wide setting."
  aiProcessingEnabled: boolean | null;
  // PRIV-001 "pause a connection's processing without fully disconnecting it."
  paused: boolean;
}

interface ConnectionExclusion {
  id: string;
  connectionId: string;
  excludedSenderDomain: string;
}

// CAL-001 — see apps/web's identical constant (connections/page.tsx) for why only these two.
const WRITE_BACK_PROVIDERS = new Set(["google_calendar", "microsoft_calendar"]);

// PRIV-001 — only Gmail/Outlook connections actually run their content through the AI classifier/
// extractor this toggle and the sender exclusion list gate — every other connector here (calendars,
// Drive/OneDrive/Dropbox file scans, Tasks, Contacts, Plaid) has its own separate, non-AI sync path, so
// showing an "AI processing" switch or a sender-exclusion list on those cards would offer a control that
// does nothing. Mirrors apps/web's identical constant (connections/page.tsx).
const AI_GATED_PROVIDERS = new Set(["gmail", "outlook"]);

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
  { provider: "google-drive", name: "Google Drive", description: "Find receipts, warranties, and contracts saved in your Drive." },
  { provider: "onedrive", name: "OneDrive", description: "The same file scan — for documents saved in OneDrive." },
  { provider: "dropbox", name: "Dropbox", description: "The same file scan — for documents saved in Dropbox." },
  { provider: "google-tasks", name: "Google Tasks", description: "Bring your Google Tasks lists in as tasks you can assign and track." },
  { provider: "microsoft-todo", name: "Microsoft To Do", description: "The same task sync — for lists in Microsoft To Do." },
  // §14 "Contacts, People & Relationships" (PEO-001) — same OAuth-in-system-browser pattern as every
  // other connector on this screen; the server side already exists (PeopleController's
  // google-contacts/microsoft-contacts authorize routes), only the mobile entry point was missing.
  { provider: "google-contacts", name: "Google Contacts", description: "Bring in your Google contacts as people you can track and share." },
  { provider: "microsoft-contacts", name: "Microsoft Contacts", description: "The same contact sync — for a Microsoft 365 or Outlook.com address book." },
] as const;

export default function ConnectionsScreen() {
  const { theme } = useAppTheme();
  const locale = useActiveFormattingLocale();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  // PRIV-001 "per-source AI-processing toggle" — the account-wide default a connection with a null
  // override falls back to. Fetched alongside connectors rather than via useAuth()'s SessionUser, which
  // doesn't carry this field.
  const [accountAiProcessingEnabled, setAccountAiProcessingEnabled] = useState<boolean | null>(null);
  const [financialAccounts, setFinancialAccounts] = useState<FinancialAccount[]>([]);
  const [financialTransactions, setFinancialTransactions] = useState<FinancialTransaction[]>([]);
  const [financeSummary, setFinanceSummary] = useState<FinanceSummary | null>(null);
  const [incomeStreams, setIncomeStreams] = useState<IncomeStream[]>([]);
  const [accountToggleBusyId, setAccountToggleBusyId] = useState<string | null>(null);
  const [accountToggleError, setAccountToggleError] = useState<string | null>(null);
  const [inboundAlias, setInboundAlias] = useState<InboundAliasInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedMessage, setConnectedMessage] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [showIcsForm, setShowIcsForm] = useState(false);
  // §28.9 step-up auth on the destructive disconnect+delete path — only needed when the server actually
  // asks for one (OAuth-only accounts skip the check entirely).
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePasswordRequired, setDeletePasswordRequired] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [deviceCalendarSyncing, setDeviceCalendarSyncing] = useState(false);
  const [deviceCalendarMessage, setDeviceCalendarMessage] = useState<string | null>(null);
  const [remindersSyncing, setRemindersSyncing] = useState(false);
  const [remindersMessage, setRemindersMessage] = useState<string | null>(null);
  const [bankConnecting, setBankConnecting] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);
  // Distinct from the 401 case below (api-client.ts's own redirect already handles that) — a transient
  // 500/network error previously fell into the same blanket swallow and left `connections` null forever
  // with no visible error or way to retry short of leaving the screen.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setConnections(await api.get<Connection[]>("/v1/connectors"));
      setAccountAiProcessingEnabled((await api.get<{ aiProcessingEnabled: boolean }>("/v1/auth/me")).aiProcessingEnabled);
      setInboundAlias(await api.get<InboundAliasInfo>("/v1/auth/inbound-alias"));
      const accounts = await api.get<FinancialAccount[]>("/v1/finance/accounts");
      setFinancialAccounts(accounts);
      setFinancialTransactions(await api.get<FinancialTransaction[]>("/v1/finance/transactions"));
      // FIN-001/FIN-003 — only worth fetching once there's at least one account, same gate as apps/web.
      if (accounts.length > 0) {
        setFinanceSummary(await api.get<FinanceSummary>("/v1/finance/summary"));
        setIncomeStreams(await api.get<IncomeStream[]>("/v1/finance/income-streams"));
      }
      setLoadError(null);
    } catch (err) {
      // Found live on a real iOS simulator: an unauthenticated cold deep-link launch straight into this
      // screen (e.g. tapping a `veynlo://connections?...` link before ever signing in) 401s here with no
      // handler, surfacing as an uncaught-rejection dev-mode error screen. `api-client.ts`'s own 401
      // handling already redirects to sign-in as a side effect of the request itself — this screen doesn't
      // need to do anything further with that error, just not let it go unhandled while that redirect
      // lands. Anything else (network drop, transient 500) needs a real visible error + retry.
      if (!(err instanceof ApiError) || err.status !== 401) {
        setLoadError(err instanceof ApiError ? err.message : "Please check your connection and try again.");
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // §AUTH "OAuth connect from mobile opens the system browser and finishes there rather than deep-linking
  // back into the app" — the server's callback now 302s to `veynlo://connections?connected=...`/`?error=...`
  // (see services/api's connectors.controller.ts) instead of a web-only URL, and iOS/Android hand that
  // scheme straight back to this already-running app — expo-router auto-routes it here since this file IS
  // `connections`. Reads the params exactly once and clears them so backgrounding/foregrounding the app
  // doesn't re-show the same banner. Mirrors apps/web's identical `?connected=`/`?error=` handling.
  //
  // Found live on a real iOS Simulator (not just Playwright/expo-web): `router.setParams` threw "Attempted
  // to navigate before mounting the Root Layout component" and the screen never rendered at all, both on a
  // genuinely cold launch AND — this is the part a `useRootNavigationState()?.key` guard alone does NOT
  // fix, confirmed by reproducing it live with that guard already in place — when a *second* deep link
  // arrives at an already-running app and React Navigation mounts a fresh instance of this screen for it.
  // `rootNavigationState?.key` being truthy means the root navigator has mounted at some point; it does
  // NOT mean this particular freshly-mounted screen's own navigation context has finished attaching on the
  // native side, and `router.setParams` can still fire before that's true. Deferring the actual call to
  // the next tick (`setTimeout(..., 0)`) — while keeping the `rootNavigationState` check too, since there's
  // no reason to even attempt this before the root navigator exists at all — reliably clears both cases:
  // confirmed by re-running the exact repro (cold launch, then a second deep link at an already-running
  // app) after this fix with zero error overlay either time.
  const rootNavigationState = useRootNavigationState();
  const params = useLocalSearchParams<{ connected?: string; error?: string }>();
  useEffect(() => {
    if (!rootNavigationState?.key) return; // root navigator not mounted yet — wait for the next render
    const { connected, error } = params;
    if (connected) setConnectedMessage(`${PROVIDER_LABEL[connected] ?? connected} connected.`);
    if (error) setConnectError(CONNECT_ERROR_MESSAGE[error] ?? "Couldn't complete that connection. Please try again.");
    if (!connected && !error) return;
    const timeoutId = setTimeout(() => router.setParams({ connected: undefined, error: undefined }), 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootNavigationState?.key, params.connected, params.error]);

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
    setConnectedMessage(null);
    // Confirmed live under `expo start --web`: react-native-web's Linking.openURL is a thin wrapper around
    // `window.open(url, '_blank', 'noopener')` (see react-native-web/dist/exports/Linking/index.js) that
    // never checks whether the browser actually allowed the popup — it resolves either way. Browsers only
    // treat window.open() as gesture-triggered when it happens SYNCHRONOUSLY within the click handler;
    // calling it after the `await api.get(...)` below (as this used to) loses that "transient activation",
    // so the popup gets silently blocked on a real, intermittent basis (reproduced repeatedly: the exact
    // same click sometimes opens the OAuth tab and sometimes does nothing at all, depending on how long the
    // authorize call took) with zero feedback to the user — no tab, no error banner, nothing. Native's real
    // Linking.openURL has no such restriction (it hands the URL to the OS, not a browser popup API), so this
    // only matters for Platform.OS === "web". Fix: open a blank tab SYNCHRONOUSLY here, before any await —
    // still within the same click's transient activation — then navigate that already-open tab once the
    // authorize URL comes back, instead of opening a fresh window after the fact.
    const isWeb = Platform.OS === "web" && typeof window !== "undefined";
    const popupWindow = isWeb ? window.open("", "_blank") : null;
    if (isWeb && !popupWindow) {
      setConnectError("Your browser blocked the pop-up window for this connection. Please allow pop-ups for this site and try again.");
      return;
    }
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(`/v1/connectors/${provider.provider}/authorize`);
      // Opens the system browser; the OAuth provider eventually redirects it to `veynlo://connections`,
      // which the OS hands back to this app (see the deep-link effect above) rather than stranding the
      // user in the browser on a page that belongs to the web app.
      if (popupWindow) {
        popupWindow.location.href = authorizationUrl;
      } else {
        await Linking.openURL(authorizationUrl);
      }
    } catch (err) {
      popupWindow?.close();
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? `${provider.name} isn't configured on this deployment yet.`
          : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  const [writeBackError, setWriteBackError] = useState<string | null>(null);
  const [writeBackBusyId, setWriteBackBusyId] = useState<string | null>(null);

  /** CAL-001 write-back toggle — see apps/web's identical `toggleWriteBack` (connections/page.tsx) for the
   * WRITE_SCOPE_REQUIRED/reconnect contract; this mirrors `connect`'s own popup-window handling for the
   * reconnect authorize URL since it's the exact same "must open synchronously to survive the gesture"
   * constraint under `expo start --web`. */
  async function toggleWriteBack(connection: Connection, enabled: boolean) {
    setWriteBackError(null);
    setWriteBackBusyId(connection.id);
    try {
      await api.patch(`/v1/connectors/${connection.id}/write-back`, { enabled });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "WRITE_SCOPE_REQUIRED") {
        const authorizeSlug = connection.provider.replace(/_/g, "-");
        const isWeb = Platform.OS === "web" && typeof window !== "undefined";
        const popupWindow = isWeb ? window.open("", "_blank") : null;
        if (isWeb && !popupWindow) {
          setWriteBackError("Your browser blocked the pop-up window for this reconnect. Please allow pop-ups for this site and try again.");
          setWriteBackBusyId(null);
          return;
        }
        try {
          const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(
            `/v1/connectors/${authorizeSlug}/authorize?writeBack=true&reconnectId=${connection.id}`,
          );
          if (popupWindow) popupWindow.location.href = authorizationUrl;
          else await Linking.openURL(authorizationUrl);
        } catch {
          popupWindow?.close();
          setWriteBackError("Couldn't start the reconnect flow. Please try again.");
        }
      } else {
        setWriteBackError(err instanceof ApiError ? err.message : "Couldn't update write-back. Please try again.");
      }
    } finally {
      setWriteBackBusyId(null);
    }
  }

  const [aiProcessingError, setAiProcessingError] = useState<string | null>(null);
  const [aiProcessingBusyId, setAiProcessingBusyId] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pauseBusyId, setPauseBusyId] = useState<string | null>(null);

  /** PRIV-001 "per-source AI-processing toggle" — `enabled: null` clears the override back to inheriting
   * the account-wide setting. Mirrors apps/web's identical `setAiProcessing` (connections/page.tsx). */
  async function setAiProcessing(connection: Connection, enabled: boolean | null) {
    setAiProcessingError(null);
    setAiProcessingBusyId(connection.id);
    try {
      await api.patch(`/v1/connectors/${connection.id}/ai-processing`, { enabled });
      await load();
    } catch (err) {
      setAiProcessingError(err instanceof ApiError ? err.message : "Couldn't update AI processing. Please try again.");
    } finally {
      setAiProcessingBusyId(null);
    }
  }

  /** PRIV-001 "pause a connection's processing without fully disconnecting it." */
  async function setPaused(connection: Connection, paused: boolean) {
    setPauseError(null);
    setPauseBusyId(connection.id);
    try {
      await api.patch(`/v1/connectors/${connection.id}/pause`, { paused });
      await load();
    } catch (err) {
      setPauseError(err instanceof ApiError ? err.message : "Couldn't update this connection. Please try again.");
    } finally {
      setPauseBusyId(null);
    }
  }

  async function disconnect(id: string, deleteDerivedData: boolean, password?: string) {
    setDisconnectError(null);
    try {
      await api.post(`/v1/connectors/${id}/disconnect`, { deleteDerivedData, password });
      setConfirmingDeleteId(null);
      setDeletePasswordRequired(false);
      setDeletePassword("");
      load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setDeletePasswordRequired(true);
        return;
      }
      setDisconnectError(err instanceof ApiError ? err.message : "Couldn't disconnect. Please try again.");
    }
  }

  /**
   * Phase 2 §52.2 "financial aggregator" — mirrors apps/web's `PlaidConnectCard` (connections/page.tsx)
   * exactly: fetch a short-lived link token from the same backend endpoint the web app uses, open Plaid
   * Link (the native SDK here, its script-loaded widget there), then exchange the public token it hands
   * back for a durable connection via the same `/v1/connectors/plaid/exchange` route. `openPlaidLink`
   * resolves to "cancelled" when the user just closes Link without finishing — that's not an error, so no
   * banner for it, just a quiet return to the idle state (see plaid-link.native.ts's onExit handling).
   */
  async function connectBank() {
    setBankError(null);
    setBankConnecting(true);
    try {
      const { linkToken } = await api.post<{ linkToken: string; expiration: string }>("/v1/connectors/plaid/link-token");
      const result = await openPlaidLink(linkToken);
      if (result.status === "success") {
        await api.post("/v1/connectors/plaid/exchange", { publicToken: result.publicToken });
        await load();
      } else if (result.status === "error") {
        setBankError(result.message);
      }
    } catch (err) {
      setBankError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? "Bank connections aren't configured on this deployment yet."
          : err instanceof ApiError
            ? err.message
            : "Couldn't start connecting a bank. Please try again.",
      );
    } finally {
      setBankConnecting(false);
    }
  }

  /** FIN-001 "account list allows per-account inclusion/exclusion" — mirrors apps/web's identical toggle. */
  async function toggleAccountIncluded(account: FinancialAccount) {
    setAccountToggleError(null);
    setAccountToggleBusyId(account.id);
    try {
      await api.patch(`/v1/finance/accounts/${account.id}`, { isIncluded: !account.isIncluded });
      await load();
    } catch (err) {
      setAccountToggleError(err instanceof ApiError ? err.message : "Couldn't update that account. Please try again.");
    } finally {
      setAccountToggleBusyId(null);
    }
  }

  /** FIN-003 "confirm recurring stream / dismiss" — a user's "not income" correction. */
  async function dismissIncomeStream(id: string) {
    await api.post(`/v1/finance/income-streams/${id}/dismiss`);
    await load();
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

      {connectedMessage && (
        <View style={{ backgroundColor: theme.colors.positiveSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.positiveSubtleText, fontSize: 13 }}>{connectedMessage}</Text>
        </View>
      )}

      {connectError && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 13 }}>{connectError}</Text>
        </View>
      )}

      {writeBackError && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 13 }}>{writeBackError}</Text>
        </View>
      )}

      {aiProcessingError && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 13 }}>{aiProcessingError}</Text>
        </View>
      )}

      {pauseError && (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 13 }}>{pauseError}</Text>
        </View>
      )}

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

        <Card style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Bank accounts</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Securely link a bank or card to confirm purchases, bills, and refunds automatically.
              </Text>
            </View>
            {plaidLinkAvailable && (
              <Button variant="secondary" onPress={connectBank} loading={bankConnecting}>
                Connect a bank
              </Button>
            )}
          </View>
          {!plaidLinkAvailable && (
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              Connecting a bank isn&apos;t available in this preview — use the installed app, or connect from veynlo.com on the web.
            </Text>
          )}
          {bankError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{bankError}</Text>}
          {/* FIN-001 "account list allows per-account inclusion/exclusion" — total computed server-side
              (FinanceService.summary) so excluded accounts/multiple currencies are handled honestly. */}
          {financeSummary && financeSummary.totalsByCurrency.length > 0 && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
              Total across included accounts:{" "}
              <Text style={{ fontWeight: "600", color: theme.colors.textPrimary }}>
                {financeSummary.totalsByCurrency.map((t) => formatMoney(t.totalMinorUnits, t.currency, locale)).join(" + ")}
              </Text>
              {financeSummary.excludedAccountCount > 0 &&
                ` (${financeSummary.excludedAccountCount} account${financeSummary.excludedAccountCount === 1 ? "" : "s"} excluded)`}
            </Text>
          )}
          {accountToggleError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{accountToggleError}</Text>}
          {financialAccounts.map((account) => (
            <View key={account.id} style={{ paddingTop: 4, opacity: account.isIncluded ? 1 : 0.5 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }} numberOfLines={1}>
                  {account.name}
                  {account.mask ? ` ····${account.mask}` : ""}
                  {!account.isIncluded ? " (excluded)" : ""}
                </Text>
                {account.currentBalanceMinorUnits !== null && (
                  <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>
                    {formatMoney(account.currentBalanceMinorUnits, account.currency, locale)}
                  </Text>
                )}
                <Button
                  variant="ghost"
                  onPress={() => toggleAccountIncluded(account)}
                  loading={accountToggleBusyId === account.id}
                >
                  {account.isIncluded ? "Exclude" : "Include"}
                </Button>
              </View>
              {/* FIN-005 "liability deadlines" — nothing rendered when this account has no liability data. */}
              {account.liability && (account.liability.minimumPaymentMinorUnits != null || account.liability.dueDate) && (
                <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                  {account.liability.minimumPaymentMinorUnits != null &&
                    `Minimum payment ${formatMoney(account.liability.minimumPaymentMinorUnits, account.currency, locale)}`}
                  {account.liability.minimumPaymentMinorUnits != null && account.liability.dueDate ? " · " : ""}
                  {account.liability.dueDate ? `due ${new Date(`${account.liability.dueDate}T00:00:00Z`).toLocaleDateString()}` : ""}
                </Text>
              )}
            </View>
          ))}
          {/* FIN-003 "Recurring income/outflow" — read-only detected paycheck streams. */}
          {incomeStreams.length > 0 && (
            <View style={{ gap: 4, marginTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
                Recurring income detected
              </Text>
              {incomeStreams.map((stream) => (
                <View key={stream.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }} numberOfLines={1}>
                    ~{formatMoney(stream.averageAmountMinorUnits, stream.currency, locale)} every {stream.cadenceLabel} from {stream.description}
                  </Text>
                  <Button variant="ghost" onPress={() => dismissIncomeStream(stream.id)}>
                    Not income
                  </Button>
                </View>
              ))}
            </View>
          )}
          {financialTransactions.length > 0 && (
            <View style={{ gap: 4, marginTop: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderDefault, paddingTop: 8 }}>
              <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
                Recent transactions
              </Text>
              {financialTransactions.slice(0, 15).map((txn) => (
                <View key={txn.id}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                    <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }} numberOfLines={1}>
                      {txn.merchantName ?? txn.name}
                      {txn.pending ? " (pending)" : ""}
                      {(txn.matchedPurchaseId || txn.matchedBillId) ? " · matched" : ""}
                    </Text>
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{formatMoney(txn.amountMinorUnits, txn.currency, locale)}</Text>
                  </View>
                  <TransactionHistoryDisclosure transactionId={txn.id} currency={txn.currency} />
                </View>
              ))}
            </View>
          )}
        </Card>

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

        {/* §14 "Contacts, People & Relationships" (PEO-001) "Apple Contacts / local device address book" —
            unlike email/calendar, Apple has no server-side Contacts API to OAuth into, so the only real way
            to import a device's local contacts is a native on-device picker. This card just opens that
            picker screen; the actual permission request + explicit per-contact selection (never a silent
            whole-address-book upload) lives there — see person/import-device-contacts.tsx's own doc
            comment. */}
        <Card style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>This phone's contacts</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Pick which contacts to bring in as people you're tracking. Nothing is imported without your say-so.
              </Text>
            </View>
            <Button variant="secondary" onPress={() => router.push("/person/import-device-contacts")}>
              Import
            </Button>
          </View>
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
          {!inboundAlias && <View style={{ height: 36, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md }} accessibilityElementsHidden importantForAccessibility="no" />}
          {inboundAlias && !inboundAlias.configured && (
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Email forwarding isn&apos;t configured on this deployment yet.</Text>
          )}
          {inboundAlias?.configured && inboundAlias.address && (
            <ForwardingAddress address={inboundAlias.address} onRotate={load} />
          )}
        </Card>

        {/* Phase 3 SMART-001 — data model + adapter interface only, no real provider access exists yet
            (see docs/PHASE3_PENDING_CREDENTIALS.md). Deliberately no "Connect" button here — every named
            provider needs its own OAuth app registration/partner agreement this dev environment doesn't
            have, and a working-looking button with no real backend behind it would mislead a user into
            thinking a device is actually connected. */}
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Smart home</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Home Assistant, SmartThings, Nest, Ring, Ecobee, and Philips Hue integrations are planned but not yet available on this
            deployment.
          </Text>
        </Card>
      </View>

      {!connections && !loadError && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}

      {!connections && loadError && <FetchError what="your connections" message={loadError} onRetry={load} />}

      {connections?.length === 0 && (
        <EmptyState title="No connections yet" description="Connect your email above to start finding useful things automatically." />
      )}

      {connections && connections.length > 0 && (
        <View style={{ gap: 8 }}>
          {connections.map((c) => (
            <Card key={c.id} style={{ gap: 6 }}>
              {/* Found live at 390px width: provider name + health badge + both action buttons never fit on
                  one row (a long label like "Outlook" plus a wide badge like "reauth required" plus
                  "Disconnect" and "Delete data" easily exceeds a phone-width card), and this row had neither
                  flexWrap nor a text-truncation strategy — the overflow just got clipped by the card's edge,
                  visually cutting "Delete data" down to "da" with no way to tap it at all. Splitting the
                  label/badge and the actions onto their own rows (same stacked pattern documents.tsx already
                  uses for its Open/Share/Delete row) gives each row the full card width instead of splitting
                  one row three or four ways. */}
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                  {PROVIDER_LABEL[c.provider] ?? c.provider}
                </Text>
                <Badge tone={HEALTH_TONE[c.health] ?? "neutral"}>{c.health.replace(/_/g, " ")}</Badge>
                {/* PRIV-001 "pause a connection's processing without fully disconnecting it" — distinct
                    from `health`, so a paused-but-healthy connection still shows a visible signal that
                    nothing is actually syncing right now. */}
                {c.paused && <Badge tone="warning">paused</Badge>}
              </View>
              {confirmingDeleteId !== c.id && (
                // Found live: `gap: 4` between two borderless ghost buttons whose labels are both short,
                // adjacent action verbs ("Disconnect" / "Delete data") rendered them with no visible
                // separation at all — read as one run-on phrase "Disconnect Delete data" with no way to
                // tell where the first tap target ends and the second begins. 20 gives them the same clear
                // separation the web version's `gap-4` (16px, between longer labels that had more natural
                // whitespace of their own) already provides. `flexWrap` added alongside the new Pause/
                // Resume button — three ghost buttons in a row is more likely to hit the same 390px-width
                // overflow this row was already fixed for once (see the comment above this card).
                <View style={{ flexDirection: "row", gap: 20, flexWrap: "wrap" }}>
                  <Button variant="ghost" onPress={() => setPaused(c, !c.paused)} loading={pauseBusyId === c.id}>
                    {c.paused ? "Resume" : "Pause"}
                  </Button>
                  <Button variant="ghost" onPress={() => disconnect(c.id, false)}>
                    Disconnect
                  </Button>
                  <Button variant="ghost" onPress={() => setConfirmingDeleteId(c.id)}>
                    Delete data
                  </Button>
                </View>
              )}
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{c.itemsDiscoveredCount} items discovered</Text>
              {c.healthDetail && <Text style={{ fontSize: 12, color: theme.colors.warningSubtleText }}>{c.healthDetail}</Text>}
              {WRITE_BACK_PROVIDERS.has(c.provider) && (
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingTop: 4 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Write new events back</Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
                      An event you create or edit in Veynlo is also created/updated on this calendar.
                    </Text>
                  </View>
                  <Switch
                    value={c.writeBackEnabled}
                    onValueChange={(checked) => toggleWriteBack(c, checked)}
                    disabled={writeBackBusyId === c.id}
                    accessibilityLabel="Write new events back"
                    trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                    {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
                  />
                </View>
              )}
              {AI_GATED_PROVIDERS.has(c.provider) && (
                <View style={{ gap: 10, paddingTop: 4, borderTopWidth: 1, borderTopColor: theme.colors.borderDefault }}>
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>
                        Process this connection&apos;s content with AI
                      </Text>
                      <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
                        {c.aiProcessingEnabled === null
                          ? `Currently following your account-wide setting (${accountAiProcessingEnabled === false ? "off" : "on"}). Toggling here overrides it just for this connection.`
                          : "Overridden for this connection — independent of your account-wide AI processing setting."}
                      </Text>
                    </View>
                    <Switch
                      value={c.aiProcessingEnabled ?? accountAiProcessingEnabled ?? true}
                      onValueChange={(checked) => setAiProcessing(c, checked)}
                      disabled={aiProcessingBusyId === c.id}
                      accessibilityLabel="Process this connection's content with AI"
                      trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                      {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
                    />
                  </View>
                  {c.aiProcessingEnabled !== null && (
                    <Text accessibilityRole="button"
                      style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}
                      onPress={() => setAiProcessing(c, null)}
                    >
                      Go back to following the account-wide setting
                    </Text>
                  )}
                  <ExclusionsManager connectionId={c.id} />
                </View>
              )}
              {confirmingDeleteId === c.id && (
                <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
                    This permanently deletes the purchases, bills, appointments, and other items found via this connection. It
                    can&apos;t be undone.
                  </Text>
                  {deletePasswordRequired && (
                    <TextField
                      label="Confirm your password to continue"
                      secureTextEntry
                      autoComplete="current-password"
                      value={deletePassword}
                      onChangeText={setDeletePassword}
                      autoFocus
                    />
                  )}
                  {disconnectError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{disconnectError}</Text>}
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button onPress={() => disconnect(c.id, true, deletePassword)}>Confirm delete</Button>
                    <Button
                      variant="ghost"
                      onPress={() => {
                        setConfirmingDeleteId(null);
                        setDeletePasswordRequired(false);
                        setDeletePassword("");
                        setDisconnectError(null);
                      }}
                    >
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
  // Found live: a malformed feed URL (e.g. "not a url") 400s with a Zod fieldErrors.url entry, but this
  // showed only the generic "Request body failed validation." — the exact unhelpful-message gap
  // sign-in.tsx/sign-up.tsx already fixed for their own forms (see those files' identical comments),
  // missed here. Falls back to the generic message when the server didn't send field-level detail.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit() {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post("/v1/connectors/ics/connect", {
        url,
        feedName: feedName || undefined,
        basicAuthUsername: showAuth && basicAuthUsername ? basicAuthUsername : undefined,
        basicAuthPassword: showAuth && basicAuthPassword ? basicAuthPassword : undefined,
      });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors ?? {});
        if (!err.fieldErrors || Object.keys(err.fieldErrors).length === 0) setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
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
        error={fieldErrors.url?.[0]}
      />
      <TextField label="Name (optional)" placeholder="e.g. Kid's soccer schedule" value={feedName} onChangeText={setFeedName} />
      {!showAuth ? (
        <Text accessibilityRole="button" style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setShowAuth(true)}>
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

/**
 * PRIV-001 "exclude specific senders" — a simple per-connection excluded-senders list, gmail/outlook only
 * (this only ever renders under an `AI_GATED_PROVIDERS` card). Collapsed by default, mirroring apps/web's
 * identical `ExclusionsManager` (connections/page.tsx): its own fetch only fires once expanded, so a page
 * with several email connections doesn't fire one exclusions fetch per card for a section most people
 * never open.
 */
function ExclusionsManager({ connectionId }: { connectionId: string }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [exclusions, setExclusions] = useState<ConnectionExclusion[] | null>(null);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setExclusions(await api.get<ConnectionExclusion[]>(`/v1/connectors/${connectionId}/exclusions`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load excluded senders. Please try again.");
    }
  }, [connectionId]);

  useEffect(() => {
    if (open && exclusions === null) load();
  }, [open, exclusions, load]);

  async function addExclusion() {
    if (!domain.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/connectors/${connectionId}/exclusions`, { excludedSenderDomain: domain.trim() });
      setDomain("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that sender. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeExclusion(id: string) {
    setRemovingId(id);
    setError(null);
    try {
      await api.delete(`/v1/connectors/${connectionId}/exclusions/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that sender. Please try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="button" style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setOpen((o) => !o)}>
        {open ? "Hide excluded senders" : "Exclude specific senders from this connection"}
      </Text>
      {open && (
        <View style={{ backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 12, gap: 10 }}>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Content from these sender domains is filed unprocessed — never sent to the AI classifier, even if AI processing
            is otherwise on for this connection.
          </Text>
          {exclusions === null && !error && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
          {exclusions?.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No excluded senders yet.</Text>}
          {exclusions?.map((exclusion) => (
            <View key={exclusion.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <Text
                style={{ fontSize: 13, color: theme.colors.textPrimary, fontFamily: "monospace", flex: 1 }}
                numberOfLines={1}
              >
                {exclusion.excludedSenderDomain}
              </Text>
              <Button variant="ghost" onPress={() => removeExclusion(exclusion.id)} loading={removingId === exclusion.id}>
                Remove
              </Button>
            </View>
          ))}
          <TextField
            label="Sender domain"
            placeholder="newsletter.example.com"
            value={domain}
            onChangeText={setDomain}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Button variant="secondary" onPress={addExclusion} loading={submitting} disabled={!domain.trim()}>
            Exclude
          </Button>
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
        </View>
      )}
    </View>
  );
}

function ForwardingAddress({ address, onRotate }: { address: string; onRotate: () => void }) {
  const { theme } = useAppTheme();
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  // Found live: rotate() below had try/finally with no catch — a failed POST still propagated as an
  // unhandled promise rejection (React Native Web's crash overlay), and there was no error state to tell
  // the user the rotate didn't actually happen (they'd see the confirm panel close as if it had).
  const [rotateError, setRotateError] = useState<string | null>(null);

  async function copy() {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function rotate() {
    setRotating(true);
    setRotateError(null);
    try {
      await api.post("/v1/auth/inbound-alias/rotate");
      onRotate();
      setConfirmingRotate(false);
    } catch (err) {
      setRotateError(err instanceof ApiError ? err.message : "Couldn't generate a new address. Please try again.");
    } finally {
      setRotating(false);
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
        <Text accessibilityRole="button" style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setConfirmingRotate(true)}>
          Generate a new address
        </Text>
      ) : (
        <View style={{ backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.warningSubtleText }}>
            The current address will stop working immediately. Update anywhere you&apos;ve saved it.
          </Text>
          {rotateError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{rotateError}</Text>}
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
