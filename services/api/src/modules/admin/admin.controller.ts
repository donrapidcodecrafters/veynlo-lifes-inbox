import { Body, Controller, Get, Param, Post, Query, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { AdminGuard } from "./admin.guard";
import { SuperAdminGuard } from "./super-admin.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminService } from "./admin.service";
import { CurrentAdmin } from "./current-admin.decorator";
import type { AuthenticatedAdmin } from "./admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadEnv } from "../../config/env";
import { CreateAdminDtoSchema, type CreateAdminDto } from "./dto";

const ADMIN_SESSION_COOKIE = "veynlo_admin_session";

const SignInDtoSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
type SignInDto = z.infer<typeof SignInDtoSchema>;

const MergeMerchantsDtoSchema = z.object({ survivingMerchantId: z.string().min(1), mergedMerchantId: z.string().min(1) });
type MergeMerchantsDto = z.infer<typeof MergeMerchantsDtoSchema>;

@Controller("v1/admin")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly adminAuth: AdminAuthService,
  ) {}

  // Stricter than the global 300/60s default — admin credentials are the highest-value target in the
  // whole system, so brute-forcing this route specifically gets a much tighter cap.
  @Post("auth/sign-in")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(SignInDtoSchema))
  async signIn(@Body() dto: SignInDto, @Res({ passthrough: true }) res: FastifyReply) {
    const session = await this.adminAuth.signIn(dto.email, dto.password);
    const env = loadEnv();
    res.setCookie(ADMIN_SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "strict", // stricter than the consumer session cookie — admin console is never embedded/cross-site
      path: "/v1/admin",
      expires: session.expiresAt,
    });
    return { adminUserId: session.adminUserId };
  }

  @Post("auth/sign-out")
  @UseGuards(AdminGuard)
  async signOut(@CurrentAdmin() admin: AuthenticatedAdmin, @Res({ passthrough: true }) res: FastifyReply) {
    await this.adminAuth.signOut(admin.sessionId);
    res.clearCookie(ADMIN_SESSION_COOKIE, { path: "/v1/admin" });
    return { success: true };
  }

  @Get("me")
  @UseGuards(AdminGuard)
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return admin;
  }

  @Get("users/lookup")
  @UseGuards(AdminGuard)
  lookup(@CurrentAdmin() admin: AuthenticatedAdmin, @Query("email") email: string) {
    return this.admin.findUserByEmail(email, admin.id);
  }

  @Get("connectors/health")
  @UseGuards(AdminGuard)
  connectorHealth() {
    return this.admin.connectorHealthSummary();
  }

  @Get("audit-events")
  @UseGuards(AdminGuard)
  auditEvents() {
    return this.admin.recentAuditEvents();
  }

  @Get("merchants")
  @UseGuards(AdminGuard)
  merchants() {
    return this.admin.listMerchants();
  }

  @Get("merchants/duplicate-candidates")
  @UseGuards(AdminGuard)
  duplicateMerchantCandidates() {
    return this.admin.findDuplicateMerchantCandidates();
  }

  @Get("merchants/merge-lineage")
  @UseGuards(AdminGuard)
  merchantMergeLineage() {
    return this.admin.listMerchantMergeLineage();
  }

  @Post("merchants/merge")
  @UseGuards(AdminGuard)
  @UsePipes(new ZodValidationPipe(MergeMerchantsDtoSchema))
  mergeMerchants(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: MergeMerchantsDto) {
    return this.admin.mergeMerchants(dto.survivingMerchantId, dto.mergedMerchantId, admin.id);
  }

  @Post("merchants/merge-lineage/:lineageId/unmerge")
  @UseGuards(AdminGuard)
  unmergeMerchants(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("lineageId") lineageId: string) {
    return this.admin.unmergeMerchants(lineageId, admin.id);
  }

  // Superadmin-only — creating/revoking operator accounts is exactly the concrete action ROADMAP.md's
  // own RBAC note said role: "support"|"superadmin" was waiting for.
  @Get("admins")
  @UseGuards(AdminGuard, SuperAdminGuard)
  listAdmins() {
    return this.admin.listAdmins();
  }

  @Post("admins")
  @UseGuards(AdminGuard, SuperAdminGuard)
  @UsePipes(new ZodValidationPipe(CreateAdminDtoSchema))
  createAdmin(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: CreateAdminDto) {
    return this.admin.createAdmin(dto, admin.id);
  }

  @Post("admins/:id/revoke")
  @UseGuards(AdminGuard, SuperAdminGuard)
  revokeAdmin(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return this.admin.revokeAdmin(id, admin.id);
  }
}
