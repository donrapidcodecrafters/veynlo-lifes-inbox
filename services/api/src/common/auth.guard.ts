import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../database/database.module";
import { loadEnv } from "../config/env";
import { assertCsrfSafe } from "./csrf";
import { ALLOW_DURING_DELETION_KEY } from "./allow-during-deletion.decorator";

export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
}

// §35 SHARE-006 legacy-release inactivity trigger — how fresh `users.lastActiveAt`/`sessions.lastSeenAt`
// need to be before a real request bothers writing a new value. Inactivity thresholds are measured in
// days, so a write once every 5 minutes of active use is more than fine-grained enough for that purpose
// while keeping this guard (which runs on essentially every authenticated API call) from turning into an
// UPDATE on every single request.
const ACTIVITY_TOUCH_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Verifies the short-lived access-token JWT AND re-checks the backing
 * session row so a revoked session (AUTH-002 "sign out everywhere", stolen
 * device, household removal cascade) takes effect immediately rather than
 * waiting for token expiry.
 *
 * Two transport mechanisms for the same session token: the web client uses
 * an httpOnly cookie (immune to XSS exfiltration); native clients (no
 * shared browser cookie jar with sensible defaults) use a `Bearer` token
 * from Sign In With Apple/Google-style native flows, stored in Keychain/
 * Keystore. Both verify identically once extracted.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const bearer = request.headers?.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length)
      : undefined;
    // Bearer wins when both are present — an explicit bearer token is a deliberate credential a native/
    // extension client chose to send; a cookie could be stray (e.g. a browser extension's background
    // fetch picking up and storing a cookie via its own `host_permissions` grant even though it only ever
    // intended to authenticate with the bearer token — a real bug found and fixed elsewhere this session,
    // see identity.controller.ts's setSessionCookie doc comment). Preferring bearer here is defense in
    // depth against exactly that class of stray-cookie mixup, not just the platform-gated fix at issuance.
    const token: string | undefined = bearer ?? request.cookies?.veynlo_session;
    if (!token) throw new UnauthorizedException("No session");
    // CSRF only applies to the cookie-authenticated path — a request presenting its own bearer token
    // isn't relying on ambient browser credentials a third-party site could piggyback on.
    if (!bearer) assertCsrfSafe(request, "veynlo_session");

    const env = loadEnv();
    let payload: { sub: string; sid: string };
    try {
      // §28.8 "validate JWT ... signature algorithm allowlist" — defense-in-depth, not a currently
      // exploitable gap (this is a raw HMAC secret, not a public key that could double as one, so jose
      // already refuses any non-HMAC alg with this key type on its own). Explicit anyway so a future
      // change to how the key is constructed can't silently widen what's accepted.
      const verified = await jwtVerify(token, new TextEncoder().encode(env.SESSION_JWT_SECRET), { algorithms: ["HS256"] });
      payload = verified.payload as unknown as { sub: string; sid: string };
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }

    const [row] = await this.db
      .select({ session: schema.sessions, userStatus: schema.users.status, userLastActiveAt: schema.users.lastActiveAt })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(eq(schema.sessions.id, payload.sid))
      .limit(1);
    if (!row || row.session.revokedAt || row.session.expiresAt < new Date()) {
      throw new UnauthorizedException("Session revoked");
    }
    if (row.userStatus === "deleted") {
      // Belt-and-suspenders: requestDeletion() already revokes every session synchronously, so this
      // should be unreachable in practice — but a request already in flight when deletion is requested
      // could otherwise slip through on a token that was valid a moment ago.
      throw new UnauthorizedException("Account deleted");
    }
    if (row.userStatus === "deletion_pending") {
      // PRIV-002 "grace period if used" — a deletion-pending account CAN sign in (IdentityService.signIn's
      // own status check no longer rejects this status), specifically so it can reach the small allowlist
      // of routes marked `@AllowDuringDeletion()` (cancel-deletion, `/me`, sign-out) — everything else on
      // the API stays exactly as blocked as it was before the grace period existed. Without this branch, a
      // deletion-pending account that CAN sign in would get full API access during the grace window, which
      // defeats the point of "nothing else" in this feature's own spec.
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_DELETION_KEY, [context.getHandler(), context.getClass()]);
      if (!allowed) {
        throw new UnauthorizedException({
          code: "ACCOUNT_DELETION_PENDING",
          message: "Your account is scheduled for deletion. Cancel the deletion to continue using Veynlo.",
        });
      }
    }
    // `suspended` (packages/db/src/schema/identity.ts's userStatusEnum) existed in the schema with no
    // enforcement anywhere — set by AdminService.suspendUser below, which also revokes every live session
    // synchronously the same way requestDeletion() does, so this check is the same belt-and-suspenders
    // backstop as the deletion_pending/deleted case above rather than the primary enforcement point. A
    // distinct error code (not reusing "Account deleted") since a suspended account is reversible
    // (AdminService.unsuspendUser) and the client copy for the two cases should read differently.
    if (row.userStatus === "suspended") {
      throw new UnauthorizedException({ code: "ACCOUNT_SUSPENDED", message: "This account has been suspended." });
    }

    // §35 SHARE-006 legacy-release inactivity trigger — the real "this account is actually being used"
    // signal, updated here (not just at sign-in/refresh — see identity.service.ts's issueSession/
    // refreshSession) so a client that never lets its 14-day access token expire still shows up as active.
    // Throttled off `userLastActiveAt` (not `session.lastSeenAt`) since that's the exact column
    // LegacyReleaseService.scanInactivity reads — checking staleness against the same column being written
    // avoids ever skipping a write because a DIFFERENT session on the same account happened to touch
    // `sessions.lastSeenAt` recently while this one hadn't.
    if (Date.now() - row.userLastActiveAt.getTime() > ACTIVITY_TOUCH_THROTTLE_MS) {
      const now = new Date();
      await Promise.all([
        this.db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, row.session.id)),
        this.db.update(schema.users).set({ lastActiveAt: now }).where(eq(schema.users.id, payload.sub)),
      ]);
    }

    request.user = { userId: payload.sub, sessionId: payload.sid } satisfies AuthenticatedUser;
    return true;
  }
}
