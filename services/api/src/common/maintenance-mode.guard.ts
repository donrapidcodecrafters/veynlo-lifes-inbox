import { Injectable, ServiceUnavailableException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { FeatureFlagsService } from "../modules/feature-flags/feature-flags.service";

export const MAINTENANCE_MODE_FLAG_KEY = "maintenance_mode";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths that must keep working during a maintenance-mode freeze regardless of HTTP method:
// - /v1/admin — the ops surface used to manage the incident, including turning this flag back off; a
//   freeze that locks out the only way to unfreeze itself would be a real operational trap.
// - the two billing webhook endpoints — Stripe/RevenueCat retry on anything but a 2xx, but both have a
//   real retry ceiling; blocking them risks losing a real billing event outright rather than just
//   delaying a user action, a worse outcome than letting reconciliation keep flowing during a freeze.
const EXEMPT_PATH_PREFIXES = ["/v1/admin", "/v1/billing/webhook", "/v1/billing/revenuecat-webhook"];

/**
 * §Ops "global emergency read-only mode" — previously nothing could freeze writes app-wide short of
 * taking the whole service down (or every connector/AI provider individually via their own configured
 * kill switches, which doesn't cover ordinary CRUD). FeatureFlagsService already existed as a generic
 * kill-switch mechanism; this is the one additional global guard + flag key needed to use it for that.
 * Applied as a global APP_GUARD (see app.module.ts) so a new mutating route is covered automatically,
 * not opt-in per controller.
 */
@Injectable()
export class MaintenanceModeGuard implements CanActivate {
  constructor(private readonly flags: FeatureFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    if (SAFE_METHODS.has(request.method)) return true;

    const path: string = (request.url ?? "").split("?")[0];
    if (EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;

    if (await this.flags.isEnabled(MAINTENANCE_MODE_FLAG_KEY)) {
      throw new ServiceUnavailableException({
        code: "MAINTENANCE_MODE",
        message: "Veynlo is temporarily in read-only mode for maintenance. Your data is safe — please try again shortly.",
      });
    }
    return true;
  }
}
