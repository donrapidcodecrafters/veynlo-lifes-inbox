import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "./admin.guard";
import { AdminService } from "./admin.service";

@Controller("v1/admin")
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get("users/lookup")
  lookup(@Query("email") email: string) {
    return this.admin.findUserByEmail(email);
  }

  @Get("connectors/health")
  connectorHealth() {
    return this.admin.connectorHealthSummary();
  }

  @Get("audit-events")
  auditEvents() {
    return this.admin.recentAuditEvents();
  }
}
