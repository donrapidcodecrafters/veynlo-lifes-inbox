export class ConnectorNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} connector is not configured on this deployment (missing OAuth client credentials).`);
    this.name = "ConnectorNotConfiguredError";
  }
}
