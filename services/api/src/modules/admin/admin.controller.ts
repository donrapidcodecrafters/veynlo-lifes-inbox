import { Body, Controller, Get, Inject, Param, Post, Query, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { AdminGuard } from "./admin.guard";
import { SuperAdminGuard } from "./super-admin.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminService } from "./admin.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { CurrentAdmin } from "./current-admin.decorator";
import type { AuthenticatedAdmin } from "./admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadEnv } from "../../config/env";
import { NormalizedEmailSchema } from "../../common/normalized-email";
import {
  CreateAdminDtoSchema,
  GrantEntitlementDtoSchema,
  CreateSignupInviteDtoSchema,
  SuspendUserDtoSchema,
  type CreateAdminDto,
  type GrantEntitlementDto,
  type CreateSignupInviteDto,
  type SuspendUserDto,
} from "./dto";

// `value` — see FeatureFlagsService.getNumericValue's own doc comment — is the optional numeric/string
// payload a few flags carry alongside their bool (e.g. the backfill cost-pressure pause's per-user monthly
// cap in cost minor units). Accepted as string or number and coerced to a string before storage; omitted
// entirely leaves whatever value the row already has untouched (see setFeatureFlag below).
const SetFeatureFlagDtoSchema = z.object({
  enabled: z.boolean(),
  description: z.string().min(1).max(500).optional(),
  value: z.union([z.string(), z.number()]).optional(),
});
type SetFeatureFlagDto = z.infer<typeof SetFeatureFlagDtoSchema>;

const ADMIN_SESSION_COOKIE = "veynlo_admin_session";

const SignInDtoSchema = z.object({ email: NormalizedEmailSchema, password: z.string().min(1) });
type SignInDto = z.infer<typeof SignInDtoSchema>;

const MergeMerchantsDtoSchema = z.object({ survivingMerchantId: z.string().min(1), mergedMerchantId: z.string().min(1) });
type MergeMerchantsDto = z.infer<typeof MergeMerchantsDtoSchema>;

@Controller("v1/admin")
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AdminAuthService) private readonly adminAuth: AdminAuthService,
    @Inject(FeatureFlagsService) private readonly flags: FeatureFlagsService,
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

  @Post("users/:userId/entitlements")
  @UseGuards(AdminGuard)
  @UsePipes(new ZodValidationPipe(GrantEntitlementDtoSchema))
  grantEntitlement(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("userId") userId: string, @Body() dto: GrantEntitlementDto) {
    return this.admin.grantEntitlement(userId, dto, admin.id);
  }

  @Post("entitlements/:id/revoke")
  @UseGuards(AdminGuard)
  revokeEntitlement(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return this.admin.revokeEntitlement(id, admin.id);
  }

  // Support-level, not superadmin — same reversible, routine-support-action tier as entitlement grant/
  // revoke and merchant merge (see the SuperAdminGuard note on the admins/ routes below for where that
  // tier line is actually drawn).
  @Post("users/:userId/suspend")
  @UseGuards(AdminGuard)
  @UsePipes(new ZodValidationPipe(SuspendUserDtoSchema))
  suspendUser(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("userId") userId: string, @Body() dto: SuspendUserDto) {
    return this.admin.suspendUser(userId, dto, admin.id);
  }

  @Post("users/:userId/unsuspend")
  @UseGuards(AdminGuard)
  unsuspendUser(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("userId") userId: string) {
    return this.admin.unsuspendUser(userId, admin.id);
  }

  // AUTH-002-adjacent support tool — forces the same "sign out everywhere" revocation a user can trigger
  // on themselves from the security page, just reachable by support (compromised-account reports, a device
  // reported stolen, etc.) without requiring the account to be suspended first.
  @Post("users/:userId/force-logout")
  @UseGuards(AdminGuard)
  forceLogoutUser(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("userId") userId: string) {
    return this.admin.forceLogoutUser(userId, admin.id);
  }

  @Get("connectors/health")
  @UseGuards(AdminGuard)
  connectorHealth() {
    return this.admin.connectorHealthSummary();
  }

  @Get("model-health")
  @UseGuards(AdminGuard)
  modelHealth() {
    return this.admin.modelHealthSummary();
  }

  @Get("ai-cost")
  @UseGuards(AdminGuard)
  aiCost() {
    return this.admin.aiCostSummary();
  }

  // §48 product analytics — admin/self-visible only, same AdminGuard as every other operator-facing
  // summary on this controller; never exposed to other users.
  @Get("analytics")
  @UseGuards(AdminGuard)
  analytics() {
    return this.admin.analyticsSummary();
  }

  @Get("model-eval-runs")
  @UseGuards(AdminGuard)
  modelEvalRuns() {
    return this.admin.modelEvalSummary();
  }

  @Get("queues/health")
  @UseGuards(AdminGuard)
  queueHealth() {
    return this.admin.queueHealthSummary();
  }

  @Get("prompt-security")
  @UseGuards(AdminGuard)
  promptSecurity() {
    return this.admin.promptSecuritySummary();
  }

  @Get("privacy-requests")
  @UseGuards(AdminGuard)
  privacyRequests() {
    return this.admin.privacyRequestsWorklist();
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

  // "Pre-launch private testing distribution" (docs/ROADMAP.md). Gated at the ordinary AdminGuard, not
  // SuperAdminGuard — same tier as entitlement grant/revoke and merchant merge: a routine, reversible
  // support action, not the admin-account-management action SuperAdminGuard was actually introduced for
  // ("the first place support vs superadmin actually differs" — see the admins/ routes above). An invite
  // code only ever lets someone sign up as an ordinary user; it grants no admin-level access itself.
  @Post("invites")
  @UseGuards(AdminGuard)
  @UsePipes(new ZodValidationPipe(CreateSignupInviteDtoSchema))
  createSignupInvite(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() dto: CreateSignupInviteDto) {
    return this.admin.createSignupInvite(dto, admin.id);
  }

  @Get("invites")
  @UseGuards(AdminGuard)
  listSignupInvites() {
    return this.admin.listSignupInvites();
  }

  @Post("invites/:id/revoke")
  @UseGuards(AdminGuard)
  revokeSignupInvite(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("id") id: string) {
    return this.admin.revokeSignupInvite(id, admin.id);
  }

  // Support-level, not superadmin — a kill switch needs to be flippable by whoever's on call, the same
  // reversible-action tier as an entitlement grant/revoke, not gated behind the rarer superadmin role.
  @Get("feature-flags")
  @UseGuards(AdminGuard)
  listFeatureFlags() {
    return this.flags.list();
  }

  @Post("feature-flags/:key")
  @UseGuards(AdminGuard)
  @UsePipes(new ZodValidationPipe(SetFeatureFlagDtoSchema))
  async setFeatureFlag(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("key") key: string, @Body() dto: SetFeatureFlagDto) {
    const result = await this.flags.setEnabled(key, dto.enabled, dto.description, dto.value !== undefined ? String(dto.value) : undefined);
    await this.admin.recordAccess(admin.id, dto.enabled ? "admin.feature_flag_enable" : "admin.feature_flag_disable", "feature_flag", key);
    return result;
  }
}
