import { Body, Controller, Get, Param, Post, Query, Res, UseGuards, UsePipes } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { AdminGuard } from "./admin.guard";
import { SuperAdminGuard } from "./super-admin.guard";
import { AdminAuthService } from "./admin-auth.service";
import { AdminService } from "./admin.service";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { BillingService } from "../billing/billing.service";
import { CurrentAdmin } from "./current-admin.decorator";
import type { AuthenticatedAdmin } from "./admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { loadEnv } from "../../config/env";
import { CreateAdminDtoSchema, GrantEntitlementDtoSchema, type CreateAdminDto, type GrantEntitlementDto } from "./dto";

const SetFeatureFlagDtoSchema = z.object({ enabled: z.boolean(), description: z.string().min(1).max(500).optional() });
type SetFeatureFlagDto = z.infer<typeof SetFeatureFlagDtoSchema>;

const SetRiskPolicyDtoSchema = z.object({
  reviewThreshold: z.number().min(0).max(1),
  autoAcceptThreshold: z.number().min(0).max(1),
  policyVersion: z.string().min(1).max(50),
});
type SetRiskPolicyDto = z.infer<typeof SetRiskPolicyDtoSchema>;

const ADMIN_SESSION_COOKIE = "veynlo_admin_session";

const SignInDtoSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
type SignInDto = z.infer<typeof SignInDtoSchema>;

const MergeMerchantsDtoSchema = z.object({ survivingMerchantId: z.string().min(1), mergedMerchantId: z.string().min(1) });
type MergeMerchantsDto = z.infer<typeof MergeMerchantsDtoSchema>;

const RefundChargeDtoSchema = z.object({ note: z.string().max(500).optional() });
type RefundChargeDto = z.infer<typeof RefundChargeDtoSchema>;

@Controller("v1/admin")
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly adminAuth: AdminAuthService,
    private readonly flags: FeatureFlagsService,
    private readonly riskPolicy: RiskPolicyService,
    private readonly billing: BillingService,
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

  @Get("job-health")
  @UseGuards(AdminGuard)
  jobHealth() {
    return this.admin.jobHealthSummary();
  }

  @Get("status")
  @UseGuards(AdminGuard)
  status() {
    return this.admin.systemStatus();
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
    const result = await this.flags.setEnabled(key, dto.enabled, dto.description);
    await this.admin.recordAccess(admin.id, dto.enabled ? "admin.feature_flag_enable" : "admin.feature_flag_disable", "feature_flag", key);
    return result;
  }

  // §54.2 launch criteria #4 "critical dates/amounts never present as certain below configured domain
  // threshold" — real per-domain configuration, replacing the single hardcoded constant every domain
  // previously shared regardless of the schema's own per-domain column.
  @Get("risk-policies")
  @UseGuards(AdminGuard)
  listRiskPolicies() {
    return this.riskPolicy.list();
  }

  @Post("risk-policies/:domain")
  @UseGuards(AdminGuard)
  @UsePipes(new ZodValidationPipe(SetRiskPolicyDtoSchema))
  async setRiskPolicy(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("domain") domain: string, @Body() dto: SetRiskPolicyDto) {
    await this.riskPolicy.setThresholds(domain, dto.reviewThreshold, dto.autoAcceptThreshold, dto.policyVersion);
    await this.admin.recordAccess(admin.id, "admin.risk_policy_update", "risk_policy", domain);
    return { domain, ...dto };
  }

  // §54.2 Operations "billing support" — read-only, live Stripe data. Support-level: seeing a customer's
  // charge history carries no more risk than seeing their entitlements, which is already AdminGuard-only.
  @Get("users/:userId/charges")
  @UseGuards(AdminGuard)
  async listUserCharges(@Param("userId") userId: string) {
    return this.billing.listRecentCharges(userId);
  }

  // Real money leaves the business here, and it's not reversible by Veynlo itself (a refunded refund isn't
  // a thing) — the same irreversible-consequence tier as revokeAdmin above, not the reversible-action tier
  // entitlement grant/revoke and kill switches sit at. Gated behind SuperAdminGuard on purpose.
  @Post("charges/:chargeId/refund")
  @UseGuards(AdminGuard, SuperAdminGuard)
  @UsePipes(new ZodValidationPipe(RefundChargeDtoSchema))
  async refundCharge(@CurrentAdmin() admin: AuthenticatedAdmin, @Param("chargeId") chargeId: string, @Body() dto: RefundChargeDto) {
    const result = await this.billing.refundCharge(chargeId, admin.id, dto.note);
    await this.admin.recordAccess(admin.id, "admin.charge_refund", "stripe_charge", chargeId, {
      refundId: result.refundId,
      amountMinorUnits: result.amountMinorUnits,
      refundedUserId: result.userId,
      note: dto.note ?? null,
    });
    return result;
  }
}
