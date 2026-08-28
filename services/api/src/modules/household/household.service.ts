import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { CreateDependentDto, CreateHouseholdDto, GrantDelegationDto, InviteMemberDto } from "./dto";

@Injectable()
export class HouseholdService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * §28.17 "audit household ACL/ownership changes" — mirrors AdminService.recordAccess's shape
   * (actor/action/resource/result), but actorType: "user" for a consumer's own action rather than
   * "support_agent". beforeJson/afterJson are optional since not every action has a meaningful before
   * state (e.g. creating a new household).
   */
  private async recordAudit(
    actorUserId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    extra: { beforeJson?: unknown; afterJson?: unknown } = {},
  ) {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: actorUserId,
      action,
      resourceType,
      resourceId,
      beforeJson: extra.beforeJson,
      afterJson: extra.afterJson,
      result: "success",
    });
  }

  async create(ownerUserId: string, dto: CreateHouseholdDto) {
    const householdId = generateId("household");
    await this.db.insert(schema.households).values({ id: householdId, name: dto.name, billingOwnerUserId: ownerUserId });
    await this.db.insert(schema.householdMemberships).values({
      id: generateId("membership"),
      householdId,
      userId: ownerUserId,
      role: "household_owner",
      relationshipLabel: "self",
      status: "active",
      joinedAt: new Date(),
    });
    await this.recordAudit(ownerUserId, "household.create", "household", householdId, { afterJson: { name: dto.name } });
    return { id: householdId, name: dto.name };
  }

  async getForUser(userId: string) {
    return this.db
      .select({
        household: schema.households,
        membership: schema.householdMemberships,
      })
      .from(schema.householdMemberships)
      .innerJoin(schema.households, eq(schema.households.id, schema.householdMemberships.householdId))
      .where(and(eq(schema.householdMemberships.userId, userId), eq(schema.householdMemberships.status, "active")));
  }

  /**
   * FAM-006 enforcement point — the actual consumer of a granted delegation, not just the grant/list/
   * revoke API around it (see docs/ROADMAP.md: delegations previously existed but nothing checked them).
   * Household-scoped, not member-scoped: a delegation grants the delegate visibility into every current
   * member's data within a scope for that household, not one specific person's — matching how
   * grantDelegation itself has no per-member target field. Filtered in JS rather than a jsonb `@>` SQL
   * operator/expiry SQL comparison — a delegate has at most a handful of active delegations, and this
   * keeps the expiry/scope logic in one obviously-correct place instead of duplicated across callers.
   */
  async delegatedHouseholdIds(delegateUserId: string, scope: string): Promise<string[]> {
    const rows = await this.db
      .select()
      .from(schema.caregiverDelegations)
      .where(and(eq(schema.caregiverDelegations.delegateUserId, delegateUserId), isNull(schema.caregiverDelegations.revokedAt)));
    const now = Date.now();
    return rows
      .filter((r) => r.scopes.includes(scope))
      .filter((r) => !r.expiresAt || r.expiresAt.getTime() > now)
      .map((r) => r.householdId);
  }

  private async assertOwnerOrAdult(householdId: string, userId: string) {
    const [membership] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          eq(schema.householdMemberships.userId, userId),
          eq(schema.householdMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!membership) throw new ForbiddenException({ code: "NOT_A_MEMBER", message: "You are not a member of this household." });
    return membership;
  }

  async listMembers(householdId: string, requestingUserId: string) {
    await this.assertOwnerOrAdult(householdId, requestingUserId);
    return this.db.select().from(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
  }

  async invite(householdId: string, requestingUserId: string, dto: InviteMemberDto) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can invite." });
    }
    const [existingInvite] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.invitedEmail, dto.email)))
      .limit(1);
    if (existingInvite) {
      throw new BadRequestException({ code: "ALREADY_INVITED", message: "This person has already been invited." });
    }
    const id = generateId("membership");
    await this.db.insert(schema.householdMemberships).values({
      id,
      householdId,
      userId: null,
      role: "adult_member",
      relationshipLabel: dto.relationshipLabel ?? null,
      status: "invited",
      invitedEmail: dto.email,
    });
    // Sending the actual invitation email is wired in the notifications module (§notifications channel) —
    // this call site only creates the durable invitation record.
    await this.recordAudit(requestingUserId, "household.invite", "household", householdId, {
      afterJson: { invitedEmail: dto.email, relationshipLabel: dto.relationshipLabel ?? null },
    });
    return { id };
  }

  async addDependent(householdId: string, requestingUserId: string, dto: CreateDependentDto) {
    await this.assertOwnerOrAdult(householdId, requestingUserId);
    const id = generateId("dependentProfile");
    await this.db.insert(schema.dependentProfiles).values({
      id,
      householdId,
      displayName: dto.displayName,
      birthDate: dto.birthDate ?? null,
      guardianUserIds: [requestingUserId],
    });
    await this.recordAudit(requestingUserId, "household.add_dependent", "dependent_profile", id, {
      afterJson: { displayName: dto.displayName, householdId },
    });
    return { id };
  }

  async listDependents(householdId: string, requestingUserId: string) {
    await this.assertOwnerOrAdult(householdId, requestingUserId);
    return this.db.select().from(schema.dependentProfiles).where(eq(schema.dependentProfiles.householdId, householdId));
  }

  async leave(householdId: string, userId: string) {
    const membership = await this.assertOwnerOrAdult(householdId, userId);
    if (membership.role === "household_owner") {
      throw new BadRequestException({
        code: "OWNER_MUST_TRANSFER",
        message: "Transfer household ownership before leaving.",
      });
    }
    await this.db
      .update(schema.householdMemberships)
      .set({ status: "left", leftAt: new Date() })
      .where(eq(schema.householdMemberships.id, membership.id));
    await this.recordAudit(userId, "household.leave", "household", householdId, {
      beforeJson: { role: membership.role, status: membership.status },
    });
  }

  /**
   * FAM-006 "time-bound, revocable, scoped access; never blanket household access." The delegate must
   * already be an active member of the household — a delegation grants an *additional*, scoped capability
   * to someone already trusted enough to be in the household, not a way to hand access to an outsider.
   */
  async grantDelegation(householdId: string, requestingUserId: string, dto: GrantDelegationDto) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can grant delegations." });
    }
    const [delegateMembership] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          eq(schema.householdMemberships.userId, dto.delegateUserId),
          eq(schema.householdMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!delegateMembership) {
      throw new BadRequestException({ code: "NOT_A_MEMBER", message: "The delegate must be an active member of this household." });
    }
    const id = generateId("caregiverDelegation");
    await this.db.insert(schema.caregiverDelegations).values({
      id,
      householdId,
      delegateUserId: dto.delegateUserId,
      scopes: dto.scopes,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      grantedByUserId: requestingUserId,
    });
    await this.recordAudit(requestingUserId, "household.delegation_grant", "caregiver_delegation", id, {
      afterJson: { delegateUserId: dto.delegateUserId, scopes: dto.scopes, expiresAt: dto.expiresAt ?? null },
    });
    return { id };
  }

  async listDelegations(householdId: string, requestingUserId: string) {
    await this.assertOwnerOrAdult(householdId, requestingUserId);
    return this.db.select().from(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.householdId, householdId));
  }

  async revokeDelegation(householdId: string, delegationId: string, requestingUserId: string) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can revoke delegations." });
    }
    const [delegation] = await this.db
      .select()
      .from(schema.caregiverDelegations)
      .where(and(eq(schema.caregiverDelegations.id, delegationId), eq(schema.caregiverDelegations.householdId, householdId)))
      .limit(1);
    if (!delegation) throw new NotFoundException({ code: "DELEGATION_NOT_FOUND", message: "Not found." });
    if (delegation.revokedAt) {
      throw new BadRequestException({ code: "ALREADY_REVOKED", message: "This delegation was already revoked." });
    }
    await this.db
      .update(schema.caregiverDelegations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.caregiverDelegations.id, delegationId));
    await this.recordAudit(requestingUserId, "household.delegation_revoke", "caregiver_delegation", delegationId, {
      beforeJson: { delegateUserId: delegation.delegateUserId, scopes: delegation.scopes },
    });
  }
}
