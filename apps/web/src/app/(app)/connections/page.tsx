"use client";

import useSWR from "swr";
import { useLocale } from "next-intl";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { useSession } from "@/hooks/use-session";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { Input, Label, FieldError } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useEffect, useState, type FormEvent } from "react";

interface InboundAliasInfo {
  configured: boolean;
  address: string | null;
}

// Keyed by the lowercased `code` field of whatever exception the OAuth callback threw — see
// connectors.controller.ts's connectorErrorRedirect.
const CONNECT_ERROR_MESSAGE: Record<string, string> = {
  connector_not_configured: "That connector isn't configured on this deployment yet.",
  invalid_oauth_state: "That connection attempt expired or was invalid. Please try again.",
  connector_failed: "Couldn't complete that connection. Please try again.",
};

interface Connection {
  id: string;
  provider: string;
  health: string;
  healthDetail: string | null;
  lastSuccessfulSyncAt: string | null;
  itemsDiscoveredCount: number;
  writeBackEnabled: boolean;
  // PRIV-001 "granted scopes"/"enabled categories" — GET /v1/connectors already returns these (raw
  // `connections` table columns, see ConnectorsService.listForUser); this page just wasn't reading them.
  scopes: string[];
  enabledCategories: string[];
  // PRIV-001 "per-source AI-processing toggle" — null means "inherit the account-wide setting."
  aiProcessingEnabled: boolean | null;
  // PRIV-001 "pause a connection's processing without fully disconnecting it."
  paused: boolean;
}

interface ConnectionExclusion {
  id: string;
  excludedSenderDomain: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  purchases: "Purchases",
  deliveries: "Deliveries",
  bills: "Bills",
  subscriptions: "Subscriptions",
  appointments: "Appointments",
  documents: "Documents",
  tasks: "Tasks",
  people: "Contacts",
};

// CAL-001 — only these two connectors ever expose write-back (a direct calendar API adapter with real
// events.insert/PATCH support — see google-calendar.adapter.ts/microsoft-calendar.adapter.ts). Gmail/
// Outlook/Drive/etc. connectors are read-only by nature (there's no "write an email back" concept here).
const WRITE_BACK_PROVIDERS = new Set(["google_calendar", "microsoft_calendar"]);

// PRIV-001 — only Gmail/Outlook connections actually run their content through IngestionService.
// classifyAndExtract (the AI classifier/extractor this toggle and the sender exclusion list gate) — every
// other connector here (calendars, Drive/OneDrive/Dropbox file scans, Tasks, Contacts, Plaid) has its own
// separate, non-AI sync path, so showing an "AI processing" switch or a sender-exclusion list on those
// cards would offer a control that does nothing.
const AI_GATED_PROVIDERS = new Set(["gmail", "outlook"]);

/** Minimal shape of the global Plaid Link puts on `window` once its script has loaded — see PlaidConnectCard. */
interface PlaidLinkHandler {
  open(): void;
}
interface PlaidLinkMetadata {
  institution?: { name: string } | null;
}
declare global {
  interface Window {
    Plaid?: {
      create(config: {
        token: string;
        onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
        onExit?: () => void;
      }): PlaidLinkHandler;
    };
  }
}
const PLAID_LINK_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

// FIN-005 — absent (null) for the common case of a non-liability account (e.g. checking); rendered per
// account only when present, never as an error/placeholder.
interface FinancialLiability {
  minimumPaymentMinorUnits: number | null;
  dueDate: string | null;
  aprBasisPoints: number | null;
}

interface FinancialAccount {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currentBalanceMinorUnits: number | null;
  currency: string;
  // FIN-001 "account list allows per-account inclusion/exclusion"
  isIncluded: boolean;
  liability: FinancialLiability | null;
}

interface FinanceSummary {
  includedAccountCount: number;
  excludedAccountCount: number;
  totalsByCurrency: Array<{ currency: string; totalMinorUnits: number }>;
}

interface IncomeStream {
  id: string;
  description: string;
  cadence: string;
  cadenceLabel: string;
  averageAmountMinorUnits: number;
  currency: string;
  occurrenceCount: number;
}

interface FinancialTransaction {
  id: string;
  name: string;
  merchantName: string | null;
  amountMinorUnits: number;
  currency: string;
  pending: boolean;
  postedDate: string | null;
  matchedPurchaseId: string | null;
  matchedBillId: string | null;
}

// §38.2 "Currency: store amount + ISO currency" — `locale` defaults to `undefined` (system/browser
// default) rather than a hardcoded "en-US", so currency symbol/grouping/decimal conventions follow
// the viewer's actual locale; callers with the resolved active locale (`useLocale()` from
// `next-intl`, itself sourced from the signed-in user's `users.locale` preference) pass it through.
function formatMoney(minorUnits: number, currency: string, locale?: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minorUnits / 100);
}

// FIN-002 "preserve provider transaction ID history and transaction revisions" — one snapshot per captured
// mutation (see packages/db/src/schema/finance.ts's transactionRevisions doc comment for what each reason
// means); shown oldest-field-first (amount/pending/date) so a user can see exactly what changed and when.
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

/** FIN-002 UI surface for `GET /v1/finance/transactions/:id/revisions` — deliberately a lightweight inline
 * disclosure on the existing transaction row (no dedicated transaction detail page exists in this app yet)
 * rather than a new route, matching this page's own existing density. */
function TransactionHistoryDisclosure({ transactionId, currency }: { transactionId: string; currency: string }) {
  const [open, setOpen] = useState(false);
  const locale = useLocale();
  const { data: revisions, error, isLoading } = useSWR<TransactionRevision[]>(open ? `/v1/finance/transactions/${transactionId}/revisions` : null, swrFetcher);

  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-xs font-medium text-brand hover:underline">
        {open ? "Hide history" : "History"}
      </button>
      {open && (
        <div className="mt-1 space-y-1 border-l-2 border-border-subtle pl-2">
          {isLoading && <p className="text-xs text-tertiary">Loading…</p>}
          {error && <p className="text-xs text-critical-subtle-text">Couldn&apos;t load history.</p>}
          {revisions && revisions.length === 0 && <p className="text-xs text-tertiary">No prior revisions — this transaction hasn&apos;t changed since it was first synced.</p>}
          {revisions?.map((r) => (
            <p key={r.id} className="text-xs text-tertiary">
              {REVISION_REASON_LABEL[r.reason]}: was {formatMoney(r.amountMinorUnits, currency, locale)}
              {r.pending ? " (pending)" : ""} on {new Date(r.createdAt).toLocaleString(locale)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
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
  google_contacts: "Google Contacts",
  microsoft_contacts: "Microsoft Contacts",
  // Found live: missing here, so a connected Plaid connection fell through to the `?? c.provider` raw-
  // string fallback below and rendered as lowercase "plaid" — the only connected card on this page not
  // showing a proper display name — and the disconnect confirm dialog read "Disconnect plaid?" instead of
  // a real name. Matches the "Bank accounts" heading its own not-yet-connected card already uses.
  plaid: "Bank accounts",
};

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
  {
    provider: "gmail",
    name: "Gmail",
    description: "Receipts, bills, appointments, and more from your inbox.",
    notConfiguredMessage: "Gmail isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "outlook",
    name: "Outlook",
    description: "The same receipts, bills, and appointments — from a Microsoft 365 or Outlook.com inbox.",
    notConfiguredMessage: "Outlook isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
  {
    provider: "google-calendar",
    name: "Google Calendar",
    description: "Sync your Google Calendar events directly — separate from Gmail, so you can connect either on its own.",
    notConfiguredMessage: "Google Calendar isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "microsoft-calendar",
    name: "Microsoft Calendar",
    description: "Sync your Outlook/Microsoft 365 calendar events directly — separate from Outlook mail.",
    notConfiguredMessage: "Microsoft Calendar isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
  {
    provider: "google-drive",
    name: "Google Drive",
    description: "Find receipts, warranties, and contracts saved as files in your Drive.",
    notConfiguredMessage: "Google Drive isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "onedrive",
    name: "OneDrive",
    description: "The same file scan — for documents saved in a Microsoft OneDrive.",
    notConfiguredMessage: "OneDrive isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
  {
    provider: "dropbox",
    name: "Dropbox",
    description: "The same file scan — for documents saved in a Dropbox account.",
    notConfiguredMessage: "Dropbox isn't configured on this deployment yet. An administrator needs to add Dropbox OAuth credentials.",
  },
  {
    provider: "google-tasks",
    name: "Google Tasks",
    description: "Bring your Google Tasks lists in as tasks you can assign and track here.",
    notConfiguredMessage: "Google Tasks isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "microsoft-todo",
    name: "Microsoft To Do",
    description: "The same task sync — for lists in Microsoft To Do.",
    notConfiguredMessage: "Microsoft To Do isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
  {
    provider: "google-contacts",
    name: "Google Contacts",
    description: "Bring in your Google contacts as People — read-only, and never overwrites what you edit here.",
    notConfiguredMessage: "Google Contacts isn't configured on this deployment yet. An administrator needs to add Google OAuth credentials.",
  },
  {
    provider: "microsoft-contacts",
    name: "Microsoft Contacts",
    description: "The same read-only contact sync — for contacts in Outlook or Microsoft 365.",
    notConfiguredMessage: "Microsoft Contacts isn't configured on this deployment yet. An administrator needs to add Microsoft OAuth credentials.",
  },
] as const;

export default function ConnectionsPage() {
  const locale = useLocale();
  // §42.5 "Historical backfill... user-visible progress" — polls while any connection is still mid-backfill
  // (health "initializing") so the "N items discovered so far" line below actually moves without the user
  // manually refreshing the page; stops polling once nothing is initializing, matching CONN-001's "usually
  // hidden unless..." posture of not burning requests once there's nothing left to watch.
  const { data, error, isLoading, mutate } = useSWR<Connection[]>("/v1/connectors", swrFetcher, {
    refreshInterval: (latest) => (latest?.some((c) => c.health === "initializing") ? 3000 : 0),
  });
  const { data: inboundAlias, mutate: mutateInboundAlias } = useSWR<InboundAliasInfo>("/v1/auth/inbound-alias", swrFetcher);
  const { data: financialAccounts, mutate: mutateAccounts } = useSWR<FinancialAccount[]>("/v1/finance/accounts", swrFetcher);
  const { data: financialTransactions, mutate: mutateTransactions } = useSWR<FinancialTransaction[]>("/v1/finance/transactions", swrFetcher);
  // FIN-001 — total balance across only the accounts the user hasn't excluded.
  const { data: financeSummary, mutate: mutateFinanceSummary } = useSWR<FinanceSummary>(
    financialAccounts && financialAccounts.length > 0 ? "/v1/finance/summary" : null,
    swrFetcher,
  );
  // FIN-003 — read-only detected paycheck/income streams; only fetched once there's at least one account.
  const { data: incomeStreams, mutate: mutateIncomeStreams } = useSWR<IncomeStream[]>(
    financialAccounts && financialAccounts.length > 0 ? "/v1/finance/income-streams" : null,
    swrFetcher,
  );
  const [accountToggleError, setAccountToggleError] = useState<string | null>(null);
  const [accountToggleBusyId, setAccountToggleBusyId] = useState<string | null>(null);
  const { user: sessionUser } = useSession();
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedMessage, setConnectedMessage] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [showIcsForm, setShowIcsForm] = useState(false);
  // §28.9 step-up auth on the destructive disconnect+delete path — only needed when the server actually
  // asks for one (OAuth-only accounts skip the check entirely).
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePasswordRequired, setDeletePasswordRequired] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [writeBackError, setWriteBackError] = useState<string | null>(null);
  const [writeBackBusyId, setWriteBackBusyId] = useState<string | null>(null);
  const [aiProcessingError, setAiProcessingError] = useState<string | null>(null);
  const [aiProcessingBusyId, setAiProcessingBusyId] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const [pauseBusyId, setPauseBusyId] = useState<string | null>(null);
  const [exclusionsOpenId, setExclusionsOpenId] = useState<string | null>(null);

  // Reads the ?connected=/?error= params the OAuth callback redirects here with (a real browser
  // navigation, not something this page's own JS ever sees mid-flow), then strips them from the URL so a
  // refresh doesn't re-show the same message.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("connected");
    const error = params.get("error");
    if (connected) setConnectedMessage(`${PROVIDER_LABEL[connected] ?? connected} connected.`);
    if (error) setConnectError(CONNECT_ERROR_MESSAGE[error] ?? "Couldn't complete that connection. Please try again.");
    if (connected || error) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function connect(provider: (typeof AVAILABLE_CONNECTORS)[number]) {
    setConnectError(null);
    try {
      const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(`/v1/connectors/${provider.provider}/authorize`);
      window.location.href = authorizationUrl;
    } catch (err) {
      // Found live: a real, specific, useful backend error (e.g. CONNECTOR_LIMIT_REACHED's "Your plan
      // allows up to 1 email connection...") was being discarded here in favor of a generic
      // "couldn't start the connection" message for every code except CONNECTOR_NOT_CONFIGURED. Any other
      // ApiError now falls back to its own real message instead of a made-up generic one.
      setConnectError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? provider.notConfiguredMessage
          : err instanceof ApiError
            ? err.message
            : `Couldn't start the ${provider.name} connection. Please try again.`,
      );
    }
  }

  async function disconnect(id: string, deleteDerivedData: boolean, password?: string, providerLabel?: string) {
    if (!deleteDerivedData && !window.confirm(`Disconnect ${providerLabel ?? "this connection"}? Veynlo stops syncing from it until you reconnect.`)) return;
    setDisconnectError(null);
    try {
      await api.post(`/v1/connectors/${id}/disconnect`, { deleteDerivedData, password });
      setConfirmingDeleteId(null);
      setDeletePasswordRequired(false);
      setDeletePassword("");
      mutate();
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setDeletePasswordRequired(true);
        return;
      }
      setDisconnectError(err instanceof ApiError ? err.message : "Couldn't disconnect. Please try again.");
    }
  }

  /**
   * CAL-001 write-back toggle. Turning it off always just flips the flag. Turning it on can fail with
   * `WRITE_SCOPE_REQUIRED` (409) — every calendar connection made before this feature existed only has
   * readonly scope — in which case this redirects into the reconnect flow (`/authorize?writeBack=true&
   * reconnectId=...`), which grants the broader scope and comes back to this same page already turned on
   * (ConnectorsController's callback sets `writeBackEnabled` itself once the OAuth round trip completes).
   */
  async function toggleWriteBack(connection: Connection, enabled: boolean) {
    setWriteBackError(null);
    setWriteBackBusyId(connection.id);
    try {
      await api.patch(`/v1/connectors/${connection.id}/write-back`, { enabled });
      mutate();
    } catch (err) {
      if (err instanceof ApiError && err.code === "WRITE_SCOPE_REQUIRED") {
        const authorizeSlug = connection.provider.replace(/_/g, "-");
        try {
          const { authorizationUrl } = await api.get<{ authorizationUrl: string }>(
            `/v1/connectors/${authorizeSlug}/authorize?writeBack=true&reconnectId=${connection.id}`,
          );
          window.location.href = authorizationUrl;
          return;
        } catch {
          setWriteBackError("Couldn't start the reconnect flow. Please try again.");
        }
      } else {
        setWriteBackError(err instanceof ApiError ? err.message : "Couldn't update write-back. Please try again.");
      }
    } finally {
      setWriteBackBusyId(null);
    }
  }

  /** PRIV-001 "per-source AI-processing toggle" — `enabled: null` clears the override back to inheriting
   * the account-wide setting (see ConnectorsService.setAiProcessingOverride). */
  async function setAiProcessing(connection: Connection, enabled: boolean | null) {
    setAiProcessingError(null);
    setAiProcessingBusyId(connection.id);
    try {
      await api.patch(`/v1/connectors/${connection.id}/ai-processing`, { enabled });
      mutate();
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
      mutate();
    } catch (err) {
      setPauseError(err instanceof ApiError ? err.message : "Couldn't update this connection. Please try again.");
    } finally {
      setPauseBusyId(null);
    }
  }

  /** FIN-001 "account list allows per-account inclusion/exclusion". */
  async function toggleAccountIncluded(account: FinancialAccount) {
    setAccountToggleError(null);
    setAccountToggleBusyId(account.id);
    try {
      await api.patch(`/v1/finance/accounts/${account.id}`, { isIncluded: !account.isIncluded });
      await Promise.all([mutateAccounts(), mutateFinanceSummary()]);
    } catch (err) {
      setAccountToggleError(err instanceof ApiError ? err.message : "Couldn't update that account. Please try again.");
    } finally {
      setAccountToggleBusyId(null);
    }
  }

  /** FIN-003 "confirm recurring stream / dismiss" — a user's "not income" correction. */
  async function dismissIncomeStream(id: string) {
    await api.post(`/v1/finance/income-streams/${id}/dismiss`);
    mutateIncomeStreams();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Connections</h1>
        <p className="mt-1 text-sm text-tertiary">
          Veynlo only reads what you connect, and you can disconnect or delete it at any time.
        </p>
      </header>

      {connectedMessage && (
        <p role="status" className="rounded-lg bg-positive-subtle px-3 py-2 text-sm text-positive-subtle-text">
          {connectedMessage}
        </p>
      )}

      {connectError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {connectError}
        </p>
      )}

      {writeBackError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {writeBackError}
        </p>
      )}

      {aiProcessingError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {aiProcessingError}
        </p>
      )}

      {pauseError && (
        <p role="alert" className="rounded-lg bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-text">
          {pauseError}
        </p>
      )}

      <div className="space-y-3">
        {AVAILABLE_CONNECTORS.map((provider) => (
          <Card key={provider.provider}>
            <CardBody className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">{provider.name}</p>
                <p className="text-sm text-tertiary">{provider.description}</p>
              </div>
              <Button variant="secondary" onClick={() => connect(provider)}>
                Connect
              </Button>
            </CardBody>
          </Card>
        ))}

        <Card>
          <CardBody className="space-y-3">
            <PlaidConnectCard
              onConnected={() => {
                mutate();
                mutateAccounts();
                mutateTransactions();
              }}
            />
            {financialAccounts && financialAccounts.length > 0 && (
              <div className="space-y-2 border-t border-border-subtle pt-3">
                {/* FIN-001 "account list allows per-account inclusion/exclusion" — total is intentionally
                    computed server-side (FinanceService.summary) rather than summed here, since it's the
                    one place in the app that actually needs to skip excluded accounts/handle multiple
                    currencies honestly. */}
                {financeSummary && financeSummary.totalsByCurrency.length > 0 && (
                  <p className="text-sm text-tertiary">
                    Total across included accounts:{" "}
                    <span className="font-medium text-primary">
                      {financeSummary.totalsByCurrency.map((t) => formatMoney(t.totalMinorUnits, t.currency, locale)).join(" + ")}
                    </span>
                    {financeSummary.excludedAccountCount > 0 &&
                      ` (${financeSummary.excludedAccountCount} account${financeSummary.excludedAccountCount === 1 ? "" : "s"} excluded)`}
                  </p>
                )}
                {accountToggleError && <FieldError>{accountToggleError}</FieldError>}
                {financialAccounts.map((account) => (
                  <div key={account.id} className={`space-y-1 ${account.isIncluded ? "" : "opacity-50"}`}>
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-primary">
                        {account.name}
                        {account.mask && <span className="text-tertiary"> ····{account.mask}</span>}
                        {!account.isIncluded && <span className="ml-1.5 text-xs font-medium text-tertiary">(excluded)</span>}
                      </span>
                      <div className="flex shrink-0 items-center gap-3">
                        {account.currentBalanceMinorUnits !== null && (
                          <span className="font-medium text-primary">{formatMoney(account.currentBalanceMinorUnits, account.currency, locale)}</span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleAccountIncluded(account)}
                          disabled={accountToggleBusyId === account.id}
                          aria-label={account.isIncluded ? `Exclude ${account.name} from totals` : `Include ${account.name} in totals`}
                        >
                          {account.isIncluded ? "Exclude" : "Include"}
                        </Button>
                      </div>
                    </div>
                    {/* FIN-005 "liability deadlines" — gracefully renders nothing when this account has no
                        liability data (a checking account, or a credit card before its first sync since
                        this feature shipped) rather than showing an error or a placeholder. */}
                    {account.liability && (account.liability.minimumPaymentMinorUnits != null || account.liability.dueDate) && (
                      <p className="pl-0.5 text-xs text-tertiary">
                        {account.liability.minimumPaymentMinorUnits != null &&
                          `Minimum payment ${formatMoney(account.liability.minimumPaymentMinorUnits, account.currency, locale)}`}
                        {account.liability.minimumPaymentMinorUnits != null && account.liability.dueDate && " · "}
                        {account.liability.dueDate && `due ${new Date(`${account.liability.dueDate}T00:00:00Z`).toLocaleDateString()}`}
                        {account.liability.aprBasisPoints != null && ` · ${(account.liability.aprBasisPoints / 100).toFixed(2)}% APR`}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {/* FIN-003 "Recurring income/outflow" — read-only detected paycheck streams; a stream only
                ever shows up here once (occurrenceCount >= 3, see FinanceService.detectIncomeStreams'
                precision-first tolerances), and "Not income" is a permanent per-stream dismissal. */}
            {incomeStreams && incomeStreams.length > 0 && (
              <div className="space-y-2 border-t border-border-subtle pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Recurring income detected</p>
                {incomeStreams.map((stream) => (
                  <div key={stream.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate text-primary">
                      ~{formatMoney(stream.averageAmountMinorUnits, stream.currency, locale)} every {stream.cadenceLabel} from {stream.description}
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => dismissIncomeStream(stream.id)}>
                      Not income
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {financialTransactions && financialTransactions.length > 0 && (
              <div className="space-y-2 border-t border-border-subtle pt-3">
                <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Recent transactions</p>
                {financialTransactions.slice(0, 15).map((txn) => (
                  <div key={txn.id} className="text-sm">
                    <div className="flex items-center justify-between">
                      <span className="min-w-0 truncate text-primary">
                        {txn.merchantName ?? txn.name}
                        {txn.pending && <span className="ml-1.5 text-xs text-tertiary">(pending)</span>}
                        {(txn.matchedPurchaseId || txn.matchedBillId) && <span className="ml-1.5 text-xs text-positive-subtle-text">matched</span>}
                      </span>
                      <span className="shrink-0 pl-2 text-tertiary">{formatMoney(txn.amountMinorUnits, txn.currency, locale)}</span>
                    </div>
                    <TransactionHistoryDisclosure transactionId={txn.id} currency={txn.currency} />
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Calendar feed (ICS)</p>
                <p className="text-sm text-tertiary">Subscribe to a school, team, or shared calendar's .ics link — events sync automatically.</p>
              </div>
              {!showIcsForm && (
                <Button variant="secondary" onClick={() => setShowIcsForm(true)}>
                  Add feed
                </Button>
              )}
            </div>
            {showIcsForm && (
              <IcsConnectForm
                onDone={() => {
                  setShowIcsForm(false);
                  mutate();
                }}
                onCancel={() => setShowIcsForm(false)}
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="space-y-3">
            <div>
              <p className="text-[0.9375rem] font-medium text-primary">Forward emails to Veynlo</p>
              <p className="text-sm text-tertiary">
                Forward a receipt, itinerary, or notice to your own Veynlo address — no account access needed.
              </p>
            </div>
            {!inboundAlias && <div className="h-9 w-64 animate-pulse rounded-lg bg-subtle" />}
            {inboundAlias && !inboundAlias.configured && (
              <p className="text-sm text-tertiary">Email forwarding isn&apos;t configured on this deployment yet.</p>
            )}
            {inboundAlias?.configured && inboundAlias.address && (
              <ForwardingAddress address={inboundAlias.address} onRotate={() => mutateInboundAlias()} />
            )}
          </CardBody>
        </Card>

        {/* Phase 3 SMART-001 — data model + adapter interface only, no real provider access exists yet
            (see docs/PHASE3_PENDING_CREDENTIALS.md). Deliberately no "Connect" button — every named
            provider needs its own OAuth app registration/partner agreement this dev environment doesn't
            have, and a working-looking button with no real backend behind it would mislead a user into
            thinking a device is actually connected. */}
        <Card>
          <CardBody className="space-y-2">
            <p className="text-[0.9375rem] font-medium text-primary">Smart home</p>
            <p className="text-sm text-tertiary">
              Home Assistant, SmartThings, Nest, Ring, Ecobee, and Philips Hue integrations are planned but not yet available on this
              deployment.
            </p>
          </CardBody>
        </Card>
      </div>

      {isLoading && <div className="h-20 animate-pulse rounded-xl bg-subtle" />}

      {!isLoading && error && !data && (
        <FetchError what="your connections" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !error && data && data.length === 0 && (
        <EmptyState title="No connections yet" description="Connect your email above to start finding useful things automatically." />
      )}

      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((c) => (
            <Card key={c.id}>
              <CardBody className="space-y-3">
                {/* Found live: at 390px this row (title/badge/sync-status text on the left, two Disconnect
                    buttons on the right) had no wrap and no `min-w-0` on the text side — with a real,
                    "healthy · N items discovered · last synced ..." connector, that pushed the whole page
                    ~90px wider than the viewport instead of the buttons dropping to their own line. */}
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[0.9375rem] font-medium text-primary">{PROVIDER_LABEL[c.provider] ?? c.provider}</p>
                      <Badge tone={HEALTH_TONE[c.health] ?? "neutral"}>{c.health.replace("_", " ")}</Badge>
                      {/* PRIV-001 "pause a connection's processing without fully disconnecting it" —
                          distinct from `health`, so a paused-but-healthy connection still needs its own
                          visible signal that nothing is actually syncing right now. */}
                      {c.paused && <Badge tone="warning">paused</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-tertiary">
                      {/* §42.5 "chunked, resumable... user-visible progress" — `itemsDiscoveredCount` is now
                          written after every backfill page (not just once at the end), so this line moves
                          live while a connection is still "initializing" instead of sitting at 0 the whole
                          time — see sync-run.util.ts's recordBackfillPageProgress. */}
                      {c.health === "initializing"
                        ? `Building your history — ${c.itemsDiscoveredCount} item${c.itemsDiscoveredCount === 1 ? "" : "s"} found so far…`
                        : `${c.itemsDiscoveredCount} items discovered`}
                      {c.lastSuccessfulSyncAt && ` · last synced ${new Date(c.lastSuccessfulSyncAt).toLocaleDateString()}`}
                    </p>
                    {c.healthDetail && <p className="mt-1 text-sm text-warning-subtle-text">{c.healthDetail}</p>}
                    {c.enabledCategories.length > 0 && (
                      <p className="mt-1 text-sm text-tertiary">
                        Categories: {c.enabledCategories.map((cat) => CATEGORY_LABEL[cat] ?? cat).join(", ")}
                      </p>
                    )}
                    {c.scopes.length > 0 && (
                      <p className="mt-1 break-all text-xs text-tertiary">Granted access: {c.scopes.join(", ")}</p>
                    )}
                  </div>
                  {confirmingDeleteId !== c.id && (
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPaused(c, !c.paused)}
                        loading={pauseBusyId === c.id}
                      >
                        {c.paused ? "Resume" : "Pause"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => disconnect(c.id, false, undefined, PROVIDER_LABEL[c.provider] ?? c.provider)}
                      >
                        Disconnect
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(c.id)}>
                        Disconnect &amp; delete data
                      </Button>
                    </div>
                  )}
                </div>
                {AI_GATED_PROVIDERS.has(c.provider) && (
                  <div className="space-y-3 border-t border-border-subtle pt-3">
                    <Switch
                      id={`ai-processing-${c.id}`}
                      checked={c.aiProcessingEnabled ?? sessionUser?.aiProcessingEnabled ?? true}
                      onCheckedChange={(checked) => setAiProcessing(c, checked)}
                      disabled={aiProcessingBusyId === c.id}
                      label="Process this connection's content with AI"
                      description={
                        c.aiProcessingEnabled === null
                          ? `Currently following your account-wide setting (${sessionUser?.aiProcessingEnabled === false ? "off" : "on"}). Toggling here overrides it just for this connection.`
                          : "Overridden for this connection — independent of your account-wide AI processing setting."
                      }
                    />
                    {c.aiProcessingEnabled !== null && (
                      <button
                        type="button"
                        onClick={() => setAiProcessing(c, null)}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        Go back to following the account-wide setting
                      </button>
                    )}
                    <ExclusionsManager
                      connectionId={c.id}
                      open={exclusionsOpenId === c.id}
                      onToggle={() => setExclusionsOpenId(exclusionsOpenId === c.id ? null : c.id)}
                    />
                  </div>
                )}
                {WRITE_BACK_PROVIDERS.has(c.provider) && (
                  <div className="border-t border-border-subtle pt-3">
                    <Switch
                      id={`write-back-${c.id}`}
                      checked={c.writeBackEnabled}
                      onCheckedChange={(checked) => toggleWriteBack(c, checked)}
                      disabled={writeBackBusyId === c.id}
                      label="Write new events back to this calendar"
                      description="When on, an event you create or edit in Veynlo is also created/updated on this calendar."
                    />
                  </div>
                )}
                {confirmingDeleteId === c.id && (
                  <div className="space-y-3 rounded-lg border border-critical/40 bg-critical-subtle p-3">
                    <p className="text-sm text-critical-subtle-text">
                      This permanently deletes the purchases, bills, appointments, and other items found via this connection. It
                      can&apos;t be undone.
                    </p>
                    {deletePasswordRequired && (
                      <div>
                        <Label htmlFor="disconnect-password">Confirm your password to continue</Label>
                        <Input
                          id="disconnect-password"
                          type="password"
                          autoComplete="current-password"
                          value={deletePassword}
                          onChange={(e) => setDeletePassword(e.target.value)}
                          autoFocus
                        />
                      </div>
                    )}
                    {disconnectError && <FieldError>{disconnectError}</FieldError>}
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => disconnect(c.id, true, deletePassword)}>
                        Confirm delete
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setConfirmingDeleteId(null);
                          setDeletePasswordRequired(false);
                          setDeletePassword("");
                          setDisconnectError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function loadPlaidScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_LINK_SCRIPT_SRC}"]`);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Plaid Link")));
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PLAID_LINK_SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Plaid Link"));
    document.head.appendChild(script);
  });
}

/**
 * Phase 2 §52.2 "financial aggregator" — unlike every other connector on this page, Plaid has no
 * `/authorize` redirect. Plaid Link is a client-side widget: this fetches a short-lived `link_token`,
 * loads Plaid's own script on demand (not bundled — most sessions on this page never click "Connect a
 * bank"), opens the widget, and on success exchanges the `public_token` it hands back for a durable
 * connection server-side. Same "not configured" degradation as every other connector when PLAID_CLIENT_ID/
 * PLAID_SECRET aren't set on this deployment (a real paid Plaid account, unlike Google/Microsoft's free
 * OAuth apps) — see connectors.controller.ts's plaidLinkToken route.
 */
function PlaidConnectCard({ onConnected }: { onConnected: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      const { linkToken } = await api.post<{ linkToken: string; expiration: string }>("/v1/connectors/plaid/link-token");
      await loadPlaidScript();
      if (!window.Plaid) throw new Error("Plaid Link failed to load.");
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: (publicToken) => {
          api
            .post("/v1/connectors/plaid/exchange", { publicToken })
            .then(onConnected)
            .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't finish connecting that bank. Please try again."))
            .finally(() => setConnecting(false));
        },
        onExit: () => setConnecting(false),
      });
      handler.open();
    } catch (err) {
      setConnecting(false);
      setError(
        err instanceof ApiError && err.code === "CONNECTOR_NOT_CONFIGURED"
          ? "Bank connections aren't configured on this deployment yet."
          : err instanceof ApiError
            ? err.message
            : "Couldn't start connecting a bank. Please try again.",
      );
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[0.9375rem] font-medium text-primary">Bank accounts</p>
          <p className="text-sm text-tertiary">Securely link a bank or card to confirm purchases, bills, and refunds automatically.</p>
        </div>
        <Button variant="secondary" onClick={connect} loading={connecting}>
          Connect a bank
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </>
  );
}

function IcsConnectForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [feedName, setFeedName] = useState("");
  const [showAuth, setShowAuth] = useState(false);
  const [basicAuthUsername, setBasicAuthUsername] = useState("");
  const [basicAuthPassword, setBasicAuthPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
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
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-border-subtle bg-subtle p-3" noValidate>
      <div>
        <Label htmlFor="ics-url">Calendar feed URL</Label>
        <Input
          id="ics-url"
          type="url"
          placeholder="https://example.com/calendar.ics"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="ics-name">Name (optional)</Label>
        <Input id="ics-name" value={feedName} onChange={(e) => setFeedName(e.target.value)} placeholder="e.g. Kid's soccer schedule" />
      </div>
      {!showAuth ? (
        <button type="button" onClick={() => setShowAuth(true)} className="text-sm font-medium text-brand hover:underline">
          This feed needs a username and password
        </button>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="ics-user">Username</Label>
            <Input id="ics-user" value={basicAuthUsername} onChange={(e) => setBasicAuthUsername(e.target.value)} autoComplete="off" />
          </div>
          <div>
            <Label htmlFor="ics-pass">Password</Label>
            <Input
              id="ics-pass"
              type="password"
              value={basicAuthPassword}
              onChange={(e) => setBasicAuthPassword(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
      )}
      <FieldError>{error ?? undefined}</FieldError>
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={submitting} disabled={!url}>
          Add feed
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ForwardingAddress({ address, onRotate }: { address: string; onRotate: () => void }) {
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(address);
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
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded-lg bg-subtle px-3 py-2 text-sm text-primary">{address}</code>
        <Button variant="secondary" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {!confirmingRotate ? (
        <button type="button" onClick={() => setConfirmingRotate(true)} className="text-sm font-medium text-brand hover:underline">
          Generate a new address
        </button>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-subtle p-3">
          <p className="flex-1 text-sm text-warning-subtle-text">
            The current address will stop working immediately. Update anywhere you&apos;ve saved it.
          </p>
          <Button size="sm" onClick={rotate} loading={rotating}>
            Confirm
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmingRotate(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * PRIV-001 "exclude specific senders" — a simple per-connection excluded-senders list. Collapsed by
 * default (its own `useSWR` only fires while `open`, so a page with several email connections doesn't
 * fire one exclusions fetch per card just for a section most people never open) — expanding it is what
 * requests the list.
 */
function ExclusionsManager({ connectionId, open, onToggle }: { connectionId: string; open: boolean; onToggle: () => void }) {
  const { data, mutate } = useSWR<ConnectionExclusion[]>(open ? `/v1/connectors/${connectionId}/exclusions` : null, swrFetcher);
  const [domain, setDomain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  async function addExclusion(e: FormEvent) {
    e.preventDefault();
    if (!domain.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/connectors/${connectionId}/exclusions`, { excludedSenderDomain: domain.trim() });
      setDomain("");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that sender. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function removeExclusion(id: string) {
    setRemovingId(id);
    try {
      await api.delete(`/v1/connectors/${connectionId}/exclusions/${id}`);
      mutate();
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div>
      <button type="button" onClick={onToggle} className="text-sm font-medium text-brand hover:underline">
        {open ? "Hide excluded senders" : "Exclude specific senders from this connection"}
      </button>
      {open && (
        <div className="mt-3 space-y-3 rounded-lg border border-border-subtle bg-subtle p-3">
          <p className="text-sm text-tertiary">
            Content from these sender domains is filed unprocessed — never sent to the AI classifier, even if AI processing is
            otherwise on for this connection.
          </p>
          {data && data.length > 0 && (
            <ul className="space-y-2">
              {data.map((exclusion) => (
                <li key={exclusion.id} className="flex items-center justify-between gap-2 text-sm">
                  <code className="rounded bg-canvas px-2 py-1 text-primary">{exclusion.excludedSenderDomain}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeExclusion(exclusion.id)}
                    loading={removingId === exclusion.id}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {data && data.length === 0 && <p className="text-sm text-tertiary">No excluded senders yet.</p>}
          <form onSubmit={addExclusion} className="flex flex-wrap items-end gap-2">
            <div className="flex-1">
              <Label htmlFor={`exclude-domain-${connectionId}`}>Sender domain</Label>
              <Input
                id={`exclude-domain-${connectionId}`}
                placeholder="newsletter.example.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" loading={submitting} disabled={!domain.trim()}>
              Exclude
            </Button>
          </form>
          {error && <FieldError>{error}</FieldError>}
        </div>
      )}
    </div>
  );
}
