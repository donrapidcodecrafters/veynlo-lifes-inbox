import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedAdmin } from "./admin.guard";

/**
 * The one concrete case ROADMAP.md's own admin RBAC note anticipated: role: "support"|"superadmin"
 * exists on admin_users, but nothing branched on it until now. Managing OTHER admin operators' accounts
 * (create/list/revoke) is exactly the kind of action that shouldn't be available to "support" — stack
 * after AdminGuard (`@UseGuards(AdminGuard, SuperAdminGuard)`), which populates request.adminUser first.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const admin: AuthenticatedAdmin | undefined = request.adminUser;
    if (admin?.role !== "superadmin") {
      throw new ForbiddenException({ code: "SUPERADMIN_REQUIRED", message: "This action requires the superadmin role." });
    }
    return true;
  }
}
