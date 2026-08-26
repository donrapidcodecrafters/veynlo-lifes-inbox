import { Body, Controller, Get, Post, Query, Res, UseGuards, UsePipes } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { AdminGuard } from "./admin.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminService } from "./admin.service";
import { CurrentAdmin } from "./current-admin.decorator";
import type { AuthenticatedAdmin } from "./admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadEnv } from "../../config/env";

const ADMIN_SESSION_COOKIE = "veynlo_admin_session";

const SignInDtoSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
type SignInDto = z.infer<typeof SignInDtoSchema>;

@Controller("v1/admin")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly adminAuth: AdminAuthService,
  ) {}

  @Post("auth/sign-in")
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
}
