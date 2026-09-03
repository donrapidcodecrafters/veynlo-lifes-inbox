import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * §28.8 "per-user quotas" — a real bug found via live audit: every `@Throttle`d route (including
 * data-export, whose own code comment already claimed "per-user quotas") was actually enforced by the
 * globally-registered `ThrottlerGuard`, which buckets by raw `req.ip` with no override. Concretely: a
 * brand-new user's very first-ever export request could get 429'd because unrelated traffic from other
 * users on the same IP/NAT had already exhausted that IP's shared bucket. Route-level only (not a global
 * `APP_GUARD` replacement) — apply this AFTER an auth guard that populates `request.user`, since global
 * guards run before per-route ones and `request.user` wouldn't exist yet if this ran globally. Falls back
 * to IP when there's no authenticated user (shouldn't happen on a route that also requires auth, but keeps
 * this guard safe to use standalone).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, any>): Promise<string> {
    return req.user?.userId ?? req.ip;
  }
}
