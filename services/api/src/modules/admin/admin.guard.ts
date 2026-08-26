import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";

/**
 * MVP stand-in for the real admin RBAC/break-glass model (§48 Admin console,
 * §45 "least privilege, content hidden, break-glass reason/time limits").
 * A shared secret header is enough to keep this off the public surface
 * during early development; it must be replaced with per-operator accounts,
 * audited access, and role scoping before any real support data lands here
 * (tracked in docs/ROADMAP.md).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const provided = request.headers["x-admin-key"];
    const expected = process.env.ADMIN_API_KEY;
    if (!expected || provided !== expected) {
      throw new UnauthorizedException({ code: "ADMIN_AUTH_REQUIRED", message: "Admin access required." });
    }
    return true;
  }
}
