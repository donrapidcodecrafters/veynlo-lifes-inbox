/**
 * Phase 3 §31 "Smart Home & Connected Devices" (SMART-001 "Smart-home connector framework"). This file is
 * the ADAPTER SHAPE ONLY — mirroring `services/api/src/modules/connectors/connector.interface.ts`'s
 * `ConnectorAdapter`/`OAuthConnectorAdapter` split exactly, so a future real integration slots into this
 * codebase's existing connector pattern rather than inventing a new one.
 *
 * There is deliberately ZERO concrete class implementing this interface anywhere in this codebase. Every
 * vendor spec names (Home Assistant, SmartThings, Nest/Google Home, Alexa-compatible services, Ring,
 * Ecobee, Philips Hue) needs its own OAuth app registration or partner API agreement that does not exist
 * in this dev environment — see docs/PHASE3_PENDING_CREDENTIALS.md for exactly what each one would need.
 * Shipping a "connect" button backed by a fake/stub adapter would mislead a user into thinking a real
 * device is connected when nothing is; this interface exists purely to prove the abstraction is sound
 * (it compiles, its shape matches the existing connector pattern, and the data model it writes into —
 * `packages/db/src/schema/smart-home.ts`'s `smartConnections`/`smartDevices`/`deviceSignals` — is ready)
 * without faking a connection.
 */
export interface SmartHomeSyncResult {
  deviceCount: number;
  signalCount: number;
}

export interface SmartHomeAdapter {
  /** e.g. "home_assistant" | "smartthings" | "nest" | "alexa" | "ring" | "ecobee" | "philips_hue" */
  readonly provider: string;

  /** True once real OAuth client credentials for this provider exist in env config — same shape as
   * every connector adapter's `isConfigured()` (see `isConnectorConfigured` in `config/env.ts`). */
  isConfigured(): boolean;

  authorizationUrl(params: { redirectUri: string; state: string }): string;

  handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ smartConnectionId: string }>;

  /** SMART-001 "Connection settings show exactly which device types/signals are imported" / "device-level
   * selection" — lists what the provider account offers so the user can pick which devices/signals to
   * import; nothing is imported until `initialSync` runs against the user's actual selection. */
  listAvailableDevices(smartConnectionId: string): Promise<Array<{ providerDeviceId: string; label: string; deviceType: string; room?: string }>>;

  initialSync(smartConnectionId: string): Promise<SmartHomeSyncResult>;

  incrementalSync(smartConnectionId: string): Promise<SmartHomeSyncResult>;

  /**
   * SMART-002 "Maintenance/health signals into obligations." A real adapter, once it exists, calls this
   * after writing a `device_signals` row for anything actionable (battery low, filter due, fault,
   * offline, leak, smoke/CO, security) — this method is the one seam a future concrete adapter needs to
   * plug into to turn that signal into a real obligation, generically, without that adapter needing to
   * know anything about how attention items work. The generic implementation (file an `attention_items`
   * row, same shape `LocationService.recordGeofenceEvent` already uses for LOC-002) belongs on whatever
   * service ends up owning `SmartHomeModule` once a first real adapter is built — deliberately not
   * written here, since there is no concrete caller to exercise it against yet and an unexercised
   * "generic obligation filer" would be exactly the kind of code this pass is avoiding: real-shaped but
   * never actually run.
   */
  fileSignalAsObligation(params: {
    ownerUserId: string;
    deviceSignalId: string;
    reasonText: string;
    urgency: "low" | "normal" | "high" | "critical";
  }): Promise<{ attentionItemId: string }>;

  /** SMART-001 "perform allowed high-risk control only with confirmation" / "remote actions separately
   * enabled and reauthenticated." No adapter implements this yet — locks/cameras/thermostats need a
   * dedicated risk-policy design (spec: "risk policy blocks unsupported/unsafe controls") before any real
   * adapter is allowed to expose it, not just a method signature. */
  performControl?(params: { smartDeviceId: string; action: string; confirmedByUserId: string }): Promise<{ success: boolean }>;
}
