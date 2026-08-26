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
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token: string | undefined = request.cookies?.veynlo_session;
    if (!token) throw new UnauthorizedException("No session");

    const env = loadEnv();
    let payload: { sub: string; sid: string };
    try {
      const verified = await jwtVerify(token, new TextEncoder().encode(env.SESSION_JWT_SECRET));
      payload = verified.payload as unknown as { sub: string; sid: string };
    } catch {
      throw new UnauthorizedException("Invalid or expired session");
    }

    const [session] = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, payload.sid))
      .limit(1);
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException("Session revoked");
    }

    request.user = { userId: payload.sub, sessionId: payload.sid } satisfies AuthenticatedUser;
    return true;
  }
}
