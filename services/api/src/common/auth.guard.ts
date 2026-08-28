import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../database/database.module";
import { loadEnv } from "../config/env";

export interface AuthenticatedUser {
  userId: string;
  sessionId: string;
}

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
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const bearer = request.headers?.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length)
      : undefined;
    const token: string | undefined = request.cookies?.veynlo_session ?? bearer;
    if (!token) throw new UnauthorizedException("No session");

    const env = loadEnv();
    let payload: { sub: string; sid: string };
    try {
      const verified = await jwtVerify(token, new TextEncoder().encode(env.SESSION_JWT_SECRET));
      payload = verified.payload as unknown as { sub: string; sid: string };
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }

    const [row] = await this.db
      .select({ session: schema.sessions, userStatus: schema.users.status })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(eq(schema.sessions.id, payload.sid))
      .limit(1);
    if (!row || row.session.revokedAt || row.session.expiresAt < new Date()) {
      throw new UnauthorizedException("Session revoked");
    }
    if (row.userStatus === "deletion_pending" || row.userStatus === "deleted") {
      // Belt-and-suspenders: requestDeletion() already revokes every session synchronously, so this
      // should be unreachable in practice — but a request already in flight when deletion is requested
      // could otherwise slip through on a token that was valid a moment ago.
      throw new UnauthorizedException("Account deleted");
    }

    request.user = { userId: payload.sub, sessionId: payload.sid } satisfies AuthenticatedUser;
    return true;
  }
}
