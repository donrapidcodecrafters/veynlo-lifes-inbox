import { z } from "zod";

/** §43.1 — integration feasibility classes. UI must never claim a class the shipped connector doesn't support. */
export const FeasibilityClassSchema = z.enum([
  "direct_api", // A — official OAuth/API with required read/write capability
  "device_local", // B — OS-exposed local data (EventKit, Contacts, share sheet)
  "open_standard", // C — IMAP, CalDAV, CardDAV, ICS, WebDAV
  "aggregator", // D — Plaid-style partner abstracting many institutions
  "evidence_derived", // E — extracted from email/document evidence, no direct account API
  "share_capture", // F — user explicitly shares current content
  "restricted_future", // G — needs commercial/partner approval, not yet available
  "manual_assisted", // H — user scan/import/entry
]);
export type FeasibilityClass = z.infer<typeof FeasibilityClassSchema>;

/** §43.3 — connection health states and required UI/operational behavior. */
export const ConnectionHealthStateSchema = z.enum([
  "initializing",
  "healthy",
  "degraded",
  "rate_limited",
  "reauth_required",
  "permission_reduced",
  "provider_outage",
  "disconnected",
]);
export type ConnectionHealthState = z.infer<typeof ConnectionHealthStateSchema>;

export const ProviderKeySchema = z.enum([
  "gmail",
  "google_calendar",
  "google_contacts",
  "microsoft_mail",
  "microsoft_calendar",
  "microsoft_contacts",
  "imap_generic",
  "icloud_calendar_local",
  "ics_feed",
  "plaid",
  "manual_forwarding_alias",
]);
export type ProviderKey = z.infer<typeof ProviderKeySchema>;

export const ConnectorCategorySchema = z.enum([
  "purchases",
  "deliveries",
  "travel",
  "bills",
  "subscriptions",
  "appointments",
  "school",
  "home",
  "vehicles",
  "insurance",
  "documents",
  "other_deadlines",
]);
export type ConnectorCategory = z.infer<typeof ConnectorCategorySchema>;

export const ConnectionSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  provider: ProviderKeySchema,
  feasibilityClass: FeasibilityClassSchema,
  scopes: z.array(z.string()),
  enabledCategories: z.array(ConnectorCategorySchema),
  health: ConnectionHealthStateSchema,
  lastSuccessfulSyncAt: z.string().datetime().nullable(),
  cursor: z.string().nullable(),
  historyDepthDays: z.number().int().nullable(),
  itemsDiscoveredCount: z.number().int().default(0),
  credentialRef: z.string().nullable(), // opaque pointer into the encrypted credential vault — never the token itself; null until OAuth completes
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  disconnectedAt: z.string().datetime().nullable(),
});
export type Connection = z.infer<typeof ConnectionSchema>;

/**
 * Standard connector interface (§43.2). Every provider adapter implements
 * this contract so ingestion/health/ops code never special-cases a provider.
 */
export interface ConnectorCapabilities {
  read: ConnectorCategory[];
  write: ConnectorCategory[];
  supportsWebhook: boolean;
  supportsHistoricalBackfill: boolean;
  maxHistoryDays: number | null;
}

export interface ProviderAdapter<TRawItem = unknown, TCommand = unknown> {
  readonly provider: ProviderKey;
  readonly feasibilityClass: FeasibilityClass;

  authorize(params: { userId: string; redirectUri: string }): Promise<{ authorizationUrl: string }>;
  handleAuthorizationCallback(params: { code: string; state: string }): Promise<{ credentialRef: string }>;
  reauthorize(connectionId: string): Promise<{ authorizationUrl: string }>;
  revoke(connectionId: string): Promise<void>;
  capabilities(): ConnectorCapabilities;

  initialSync(connectionId: string, historyDepthDays: number | null): Promise<{ cursor: string }>;
  incrementalSync(connectionId: string, cursor: string): Promise<{ cursor: string; itemCount: number }>;
  handleWebhook(payload: unknown, signature: string | null): Promise<void>;
  reconcile(connectionId: string, window: { sinceIso: string }): Promise<{ repaired: number }>;

  refreshCredential(connectionId: string): Promise<void>;
  normalize(rawItem: TRawItem): Promise<{ sourceEventId: string }>;
  providerAction(connectionId: string, command: TCommand): Promise<{ commandId: string; status: string }>;

  rateLimitState(connectionId: string): Promise<{ limited: boolean; retryAfterSeconds: number | null }>;
  health(connectionId: string): Promise<{ state: ConnectionHealthState; detail: string | null }>;
  deleteProviderReference(connectionId: string): Promise<void>;
}
