import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { jwtVerify } from "jose";
import { loadEnv } from "../../config/env";
import { assertCsrfSafe } from "../../common/csrf";
import { AdminAuthService } from "./admin-auth.service";

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  role: string;
  sessionId: string;
}

/**
 * Verifies the admin session cookie (separate from the consumer session
 * cookie/JWT audience — see AdminAuthService) and re-checks the backing
 * `admin_sessions` row so revoking an operator's access takes effect
 * immediately rather than waiting for token expiry (§45 "least privilege...
 * audited access").
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(AdminAuthService) private readonly adminAuth: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token: string | undefined = request.cookies?.veynlo_admin_session;
    if (!token) throw new UnauthorizedException({ code: "ADMIN_AUTH_REQUIRED", message: "Admin sign-in required." });
    assertCsrfSafe(request, "veynlo_admin_session");

    const env = loadEnv();
    let payload: { sub: string; sid: string; aud: string };
    try {
      const verified = await jwtVerify(token, new TextEncoder().encode(env.SESSION_JWT_SECRET), { audience: "admin", algorithms: ["HS256"] });
      payload = verified.payload as unknown as { sub: string; sid: string; aud: string };
    } catch {
      throw new UnauthorizedException({ code: "ADMIN_AUTH_REQUIRED", message: "Invalid or expired admin session." });
    }

    const admin = await this.adminAuth.verifySession(payload.sub, payload.sid);
    if (!admin) throw new UnauthorizedException({ code: "ADMIN_AUTH_REQUIRED", message: "Admin session revoked." });

    request.adminUser = { ...admin, sessionId: payload.sid } satisfies AuthenticatedAdmin;
    return true;
  }
}
