import { describe, expect, it, afterAll } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { ServiceUnavailableException } from "@nestjs/common";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { FeatureFlagsService } from "../modules/feature-flags/feature-flags.service";
import { MaintenanceModeGuard, MAINTENANCE_MODE_FLAG_KEY } from "./maintenance-mode.guard";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const flags = new FeatureFlagsService(db);
const guard = new MaintenanceModeGuard(flags);

afterAll(async () => {
  await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, MAINTENANCE_MODE_FLAG_KEY));
});

function contextFor(method: string, url: string): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ method, url }) }) } as unknown as ExecutionContext;
}

describe("MaintenanceModeGuard", () => {
  it("always allows GET requests, even while the flag is on", async () => {
    await flags.setEnabled(MAINTENANCE_MODE_FLAG_KEY, true);
    await expect(guard.canActivate(contextFor("GET", "/v1/documents"))).resolves.toBe(true);
  });

  it("always allows /v1/admin routes, even while the flag is on — the guard must not lock out its own off switch", async () => {
    await flags.setEnabled(MAINTENANCE_MODE_FLAG_KEY, true);
    await expect(guard.canActivate(contextFor("POST", "/v1/admin/feature-flags/maintenance_mode"))).resolves.toBe(true);
  });

  it("always allows the billing webhook endpoints, even while the flag is on", async () => {
    await flags.setEnabled(MAINTENANCE_MODE_FLAG_KEY, true);
    await expect(guard.canActivate(contextFor("POST", "/v1/billing/webhook"))).resolves.toBe(true);
    await expect(guard.canActivate(contextFor("POST", "/v1/billing/revenuecat-webhook"))).resolves.toBe(true);
  });

  it("blocks an ordinary mutation with a real, explained 503 when the flag is on", async () => {
    await flags.setEnabled(MAINTENANCE_MODE_FLAG_KEY, true);
    const result = guard.canActivate(contextFor("POST", "/v1/documents/upload"));
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(result).rejects.toMatchObject({ response: { code: "MAINTENANCE_MODE" } });
  });

  it("allows an ordinary mutation through when the flag is off", async () => {
    await flags.setEnabled(MAINTENANCE_MODE_FLAG_KEY, false);
    await expect(guard.canActivate(contextFor("POST", "/v1/documents/upload"))).resolves.toBe(true);
  });

  it("defaults to off (allows requests) when the flag has never been configured", async () => {
    await db.delete(schema.featureFlags).where(eq(schema.featureFlags.key, MAINTENANCE_MODE_FLAG_KEY));
    await expect(guard.canActivate(contextFor("DELETE", "/v1/documents/doc_123"))).resolves.toBe(true);
  });
});
