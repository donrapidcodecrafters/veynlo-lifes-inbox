/**
 * §37 "Create ... Connector interfaces so local mocks can be replaced by AWS/provider implementations."
 * Unlike Queue/ObjectStorage/ModelProvider, the five connector adapters are never swapped for each other
 * behind one DI token — `ConnectorsController` deliberately injects each concrete adapter by name (a user
 * picks "Gmail" vs "Outlook" explicitly, they're not interchangeable implementations of one thing). The
 * value here is a compile-time contract: every adapter implementing `ConnectorAdapter`/`OAuthConnectorAdapter`
 * is checked by the TypeScript compiler to actually expose the shape the ingestion/sync pipeline and
 * controller assume, so a future connector (or a signature change to an existing one) can't silently drift
 * from what every other adapter provides.
 */
export interface ConnectorSyncResult {
  itemCount: number;
}

export interface ConnectorAdapter {
  isConfigured(): boolean;
  initialSync(connectionId: string): Promise<ConnectorSyncResult>;
  incrementalSync(connectionId: string): Promise<ConnectorSyncResult>;
}

/** Gmail, Outlook, Google Calendar, and Microsoft Calendar all connect via an OAuth authorize/callback
 * round trip; ICS (a calendar-feed URL) does not and implements only the base `ConnectorAdapter`. */
export interface OAuthConnectorAdapter extends ConnectorAdapter {
  authorizationUrl(params: { redirectUri: string; state: string }): string;
  handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }>;
}
