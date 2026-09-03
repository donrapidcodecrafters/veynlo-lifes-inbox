import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { generateId } from "@veynlo/core";
// Server-only Node util — see packages/core/src/index.ts's own doc comment for why this comes from its
// own subpath rather than the main barrel.
import { generateOpaqueToken, hashOpaqueToken } from "@veynlo/core/dist/util/token";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { escapeHtml } from "../../common/html-escape";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { MailerService } from "../notifications/mailer.service";
import type {
  CreateDependentDto,
  CreateHouseholdDto,
  GrantDelegationDto,
  InviteDependentTransitionDto,
  InviteMemberDto,
  RenameHouseholdDto,
  SetMemberLabelDto,
  TransferOwnershipDto,
} from "./dto";

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — longer-lived than a password reset since a household invite is a lower-stakes, non-account-recovery action

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(MailerService) private readonly mailer: MailerService,
  ) {}

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
    const candidateHouseholdIds = rows
      .filter((r) => r.scopes.includes(scope))
      .filter((r) => !r.expiresAt || r.expiresAt.getTime() > now)
      .map((r) => r.householdId);
    if (candidateHouseholdIds.length === 0) return [];
    // FAM-006 gap fix, found live: grantDelegation requires the delegate to already be an active member
    // of the household at grant time, but nothing re-checked that afterward — leave() doesn't revoke a
    // departing member's delegations, so a member who left the household while holding a still-unexpired
    // delegation kept full scoped read access to that household's lists/tasks/etc. indefinitely. Verified
    // live: after `POST .../leave`, `GET /v1/households` correctly came back empty for that household, but
    // `GET /v1/lists` and `GET /v1/tasks` still returned its shared rows. This is exactly the "Adult leaves
    // household" edge case the spec's own FAM-* failure list calls out, and a real privacy leak (an
    // ex-member seeing household data after leaving) — not a cosmetic gap. Filtering here at read time
    // (rather than only cleaning up in leave()) also covers any future membership-removal path, e.g. an
    // owner removing/kicking a member, without needing every such path to remember to revoke delegations.
    const activeIds = new Set(await this.activeHouseholdIds(delegateUserId));
    return candidateHouseholdIds.filter((id) => activeIds.has(id));
  }

  /**
   * FAM-005/FAM-006 gap fix: every `ownerOrDelegatedHousehold`-shaped read path (CommerceService,
   * ScheduleService, ListsService, AssetsService) OR'd the row owner against `delegatedHouseholdIds`
   * only — caregiver delegation, a *separate* opt-in grant nothing in `acceptInvite` ever creates. Plain
   * active membership (the thing every household member actually has the moment they join) was never
   * checked, so a shared household list/task/bill/property was invisible to every member except whoever
   * created it — confirmed live: a second household member's `GET /v1/lists` came back `[]` for a list
   * their own household owned, even though opening it directly by ID worked fine (`assertListAccess`
   * already checked `isActiveMember`, just inconsistently with the list/overview query). This is the
   * membership-side counterpart to `delegatedHouseholdIds`, meant to be OR'd in alongside it everywhere
   * that helper is used.
   */
  async activeHouseholdIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ householdId: schema.householdMemberships.householdId })
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.userId, userId), eq(schema.householdMemberships.status, "active")));
    return rows.map((r) => r.householdId);
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

  /**
   * Phase 2 §52.2 "assignments" — a task can only be assigned to a real, active member of a household the
   * assigner also belongs to, never an arbitrary userId (which would let one user silently attach their
   * task to someone else's account with no relationship to it at all). Public (unlike assertOwnerOrAdult)
   * since ScheduleService is the first of what's likely several other modules needing "is this user
   * actually in this household" without needing the full member list/role details listMembers returns.
   */
  async isActiveMember(householdId: string, userId: string): Promise<boolean> {
    const [membership] = await this.db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          eq(schema.householdMemberships.userId, userId),
          eq(schema.householdMemberships.status, "active"),
        ),
      )
      .limit(1);
    return Boolean(membership);
  }

  /**
   * Adult-availability heuristic's own membership query (adult-availability.ts's
   * `householdAdultBusyIntervals`, used by ConflictService.schoolTransportConflicts) — every active
   * household member holding one of the two roles that mean "a real adult with their own account and
   * calendar": `household_owner`/`adult_member`. Deliberately excludes `dependent_profile` (children live
   * in `dependentProfiles`, not `householdMemberships`, and couldn't drive anyone anywhere regardless) and
   * every other principal role (`caregiver_delegate`/`emergency_contact`/`support_agent`/
   * `service_principal`/`individual_owner`) — none of those represent a full household member whose own
   * calendar this app should treat as a candidate driver.
   */
  async activeAdultUserIds(householdId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: schema.householdMemberships.userId })
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          eq(schema.householdMemberships.status, "active"),
          or(eq(schema.householdMemberships.role, "household_owner"), eq(schema.householdMemberships.role, "adult_member"))!,
        ),
      );
    return [...new Set(rows.map((r) => r.userId).filter((id): id is string => id !== null))];
  }

  /**
   * Phase 2 §52.2 "family Today" — a household-wide aggregate of what's due/happening today across every
   * member, not just the requester's own view (which is all CommerceService/ScheduleService's per-user
   * queries plus caregiver delegation ever gave). All three domain tables (`calendar_events`, `tasks`,
   * `attention_items`) already carry `household_id` directly, so this queries by that column rather than
   * needing to enumerate every member's userId first. "Today" is the UTC calendar day — this app already
   * has one documented precedent for that same simplification (the daily brief's fixed 13:00 UTC dispatch
   * time, "per-user local-time targeting is a follow-up") rather than resolving a real household timezone,
   * which doesn't exist as a stored concept yet (only `users.timezone`, per-person).
   */
  async today(householdId: string, userId: string) {
    await this.assertOwnerOrAdult(householdId, userId);
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const events = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(eq(schema.calendarEvents.householdId, householdId), or(ne(schema.calendarEvents.visibility, "private"), eq(schema.calendarEvents.ownerUserId, userId))!))
      .orderBy(asc(schema.calendarEvents.startSort));
    const todaysEvents = events.filter((e) => e.startSort && e.startSort >= startOfDay && e.startSort < endOfDay);

    const tasks = await this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.householdId, householdId), ne(schema.tasks.state, "completed"), ne(schema.tasks.state, "dismissed")))
      .orderBy(asc(schema.tasks.dueSort));
    const dueTasks = tasks.filter((t) => !t.dueSort || t.dueSort < endOfDay);

    const attentionItems = await this.db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.householdId, householdId), eq(schema.attentionItems.resolved, false)))
      .orderBy(asc(schema.attentionItems.dueAtSort));

    return { events: todaysEvents, tasks: dueTasks, attentionItems };
  }

  async listMembers(householdId: string, requestingUserId: string) {
    await this.assertOwnerOrAdult(householdId, requestingUserId);
    // Explicit column list — inviteTokenHash/inviteTokenExpiresAt are internal accept-flow state, not
    // something a household's own members need reflected back to them (the hash isn't reversible, but
    // there's no reason to expose it either).
    return this.db
      .select({
        id: schema.householdMemberships.id,
        householdId: schema.householdMemberships.householdId,
        userId: schema.householdMemberships.userId,
        role: schema.householdMemberships.role,
        relationshipLabel: schema.householdMemberships.relationshipLabel,
        status: schema.householdMemberships.status,
        invitedEmail: schema.householdMemberships.invitedEmail,
        joinedAt: schema.householdMemberships.joinedAt,
        leftAt: schema.householdMemberships.leftAt,
      })
      .from(schema.householdMemberships)
      .where(eq(schema.householdMemberships.householdId, householdId));
  }

  async invite(householdId: string, requestingUserId: string, dto: InviteMemberDto) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can invite." });
    }

    // Found live: assertHouseholdMemberQuota is a plain `SELECT count(...) >= max` with no row lock, and
    // the insert below used to run outside any transaction — two concurrent invite() calls for the same
    // household near its seat limit could both read the same under-limit count before either's insert
    // committed, letting the household exceed household_members_max. pg_advisory_xact_lock serializes
    // every invite() call for this householdId (any concurrent call blocks here until the earlier one's
    // transaction commits or rolls back, at which point its insert — if any — is already visible), which
    // closes the race even though the quota SELECT itself runs on EntitlementsService's own connection
    // rather than this transaction. The lock is transaction-scoped, so it can never leak past this call.
    const { household, id, rawToken } = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${householdId}))`);

      const [household] = await tx.select().from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
      if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });
      await this.entitlements.assertHouseholdMemberQuota(householdId, household.billingOwnerUserId);
      // Bug fix: this used to match on invitedEmail alone regardless of status, which meant a *revoked*,
      // *declined*, or *left* invite for someone permanently blocked them from ever being invited again
      // (invitedEmail is never cleared on those transitions — only inviteTokenHash/inviteTokenExpiresAt
      // are). "Duplicate invite" should mean a currently-*pending* invite exists, not "this email
      // appeared in this household's history at any point" — confirmed live: revoking an invite and then
      // re-inviting the same email used to 400 with ALREADY_INVITED even though the row it collided with
      // had status "removed" and no live token.
      const [existingInvite] = await tx
        .select()
        .from(schema.householdMemberships)
        .where(
          and(
            eq(schema.householdMemberships.householdId, householdId),
            eq(schema.householdMemberships.invitedEmail, dto.email),
            eq(schema.householdMemberships.status, "invited"),
          ),
        )
        .limit(1);
      if (existingInvite) {
        throw new BadRequestException({ code: "ALREADY_INVITED", message: "This person has already been invited." });
      }
      // HH-001 "already-member email" failure state (spec's own edge-case list) — the existingInvite check
      // above only catches a duplicate *pending* invite; it says nothing about an email that already
      // belongs to a currently *active* member of this household. Found live: without this, re-inviting an
      // active member's email 201'd and created a second, independent "invited" membership row for the
      // same person/household — they'd then appear twice in listMembers (one "active", one "invited") and,
      // if they accepted the second invite too, a second accepted row would exist that never gets cleaned
      // up (acceptInvite has no "already a member here" check of its own either). Matched by email against
      // `users`, not by re-querying invitedEmail, since an active membership's row keeps the *original*
      // invitedEmail (never cleared on acceptance) but the thing that actually matters is the real account.
      const [existingUser] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, dto.email)).limit(1);
      if (existingUser) {
        const [activeMembership] = await tx
          .select({ id: schema.householdMemberships.id })
          .from(schema.householdMemberships)
          .where(
            and(
              eq(schema.householdMemberships.householdId, householdId),
              eq(schema.householdMemberships.userId, existingUser.id),
              eq(schema.householdMemberships.status, "active"),
            ),
          )
          .limit(1);
        if (activeMembership) {
          throw new BadRequestException({ code: "ALREADY_MEMBER", message: "This person is already a member of this household." });
        }
      }
      const id = generateId("membership");
      const rawToken = generateOpaqueToken();
      await tx.insert(schema.householdMemberships).values({
        id,
        householdId,
        userId: null,
        role: "adult_member",
        relationshipLabel: dto.relationshipLabel ?? null,
        status: "invited",
        invitedEmail: dto.email,
        inviteTokenHash: hashOpaqueToken(rawToken),
        inviteTokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
      });
      return { household, id, rawToken };
    });

    const acceptUrl = `${loadEnv().WEB_APP_URL}/accept-invite?token=${rawToken}`;
    try {
      await this.mailer.send({
        to: dto.email,
        subject: `You've been invited to join ${household.name} on Veynlo`,
        text: `You've been invited to join the "${household.name}" household on Veynlo. Accept the invite here (link expires in 7 days): ${acceptUrl}\n\nIf you weren't expecting this, you can safely ignore this email.`,
        html: `<p>You've been invited to join the "${escapeHtml(household.name)}" household on Veynlo.</p><p><a href="${acceptUrl}">Accept the invite</a> (link expires in 7 days).</p><p>If you weren't expecting this, you can safely ignore this email.</p>`,
      });
    } catch (err) {
      // Deliberately swallowed, not rethrown — the durable invitation record (and the audit trail below)
      // is the source of truth; a transient SMTP failure shouldn't fail the whole invite call, since the
      // inviter has no direct way to retry sending just the email. Logged so it's not silently invisible.
      this.logger.error(`Failed to send household-invite email: ${String(err)}`);
    }

    await this.recordAudit(requestingUserId, "household.invite", "household", householdId, {
      afterJson: { invitedEmail: dto.email, relationshipLabel: dto.relationshipLabel ?? null },
    });
    return { id };
  }

  /**
   * HH-001 "resend" — reissues a fresh token/expiry for a still-pending invite and re-sends the email.
   * Doesn't create a new membership row (that would silently orphan the old one and could trip
   * assertHouseholdMemberQuota into double-counting the same person against the seat limit) — it mutates
   * the existing "invited" row in place, exactly like a password-reset resend reuses the same account.
   */
  async resendInvite(householdId: string, membershipId: string, requestingUserId: string) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can resend invites." });
    }
    const [target] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.id, membershipId), eq(schema.householdMemberships.householdId, householdId)))
      .limit(1);
    if (!target) throw new NotFoundException({ code: "MEMBERSHIP_NOT_FOUND", message: "Not found." });
    if (target.status !== "invited" || !target.invitedEmail) {
      throw new BadRequestException({ code: "NOT_PENDING", message: "This invite is no longer pending." });
    }
    const [household] = await this.db.select().from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });

    const rawToken = generateOpaqueToken();
    await this.db
      .update(schema.householdMemberships)
      .set({ inviteTokenHash: hashOpaqueToken(rawToken), inviteTokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) })
      .where(eq(schema.householdMemberships.id, membershipId));

    const acceptUrl = `${loadEnv().WEB_APP_URL}/accept-invite?token=${rawToken}`;
    try {
      await this.mailer.send({
        to: target.invitedEmail,
        subject: `Reminder: you've been invited to join ${household.name} on Veynlo`,
        text: `You've been invited to join the "${household.name}" household on Veynlo. Accept the invite here (link expires in 7 days): ${acceptUrl}\n\nIf you weren't expecting this, you can safely ignore this email.`,
        html: `<p>You've been invited to join the "${escapeHtml(household.name)}" household on Veynlo.</p><p><a href="${acceptUrl}">Accept the invite</a> (link expires in 7 days).</p><p>If you weren't expecting this, you can safely ignore this email.</p>`,
      });
    } catch (err) {
      this.logger.error(`Failed to send household-invite resend email: ${String(err)}`);
    }

    await this.recordAudit(requestingUserId, "household.invite_resend", "household", householdId, {
      afterJson: { membershipId, invitedEmail: target.invitedEmail },
    });
  }

  /**
   * HH-001 "revoke" — cancels a still-pending invite before it's accepted. Sets status to "removed"
   * (rather than deleting the row) so the audit trail/member list history is preserved, and clears the
   * token so a copy of the old invite email can never be used to join. Also frees the invitedEmail up for
   * re-invitation immediately (see the invite() fix above narrowing ALREADY_INVITED to status="invited"),
   * and frees a seat against assertHouseholdMemberQuota (which only counts "active"/"invited" rows).
   */
  async revokeInvite(householdId: string, membershipId: string, requestingUserId: string) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can revoke invites." });
    }
    const [target] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.id, membershipId), eq(schema.householdMemberships.householdId, householdId)))
      .limit(1);
    if (!target) throw new NotFoundException({ code: "MEMBERSHIP_NOT_FOUND", message: "Not found." });
    if (target.status !== "invited") {
      throw new BadRequestException({ code: "NOT_PENDING", message: "This invite is no longer pending." });
    }
    await this.db
      .update(schema.householdMemberships)
      .set({ status: "removed", inviteTokenHash: null, inviteTokenExpiresAt: null })
      .where(eq(schema.householdMemberships.id, membershipId));
    await this.recordAudit(requestingUserId, "household.invite_revoke", "household", householdId, {
      beforeJson: { membershipId, invitedEmail: target.invitedEmail },
    });
  }

  /**
   * HH-001 "rename" — owner-only (mirrors the create()/transferOwnership() pattern: naming/identity of the
   * household is an owner-level decision, unlike inviting which any adult member can do).
   */
  async rename(householdId: string, requestingUserId: string, dto: RenameHouseholdDto) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner") {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the household owner can rename this household." });
    }
    const [household] = await this.db.select().from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });
    await this.db.update(schema.households).set({ name: dto.name, updatedAt: new Date() }).where(eq(schema.households.id, householdId));
    await this.recordAudit(requestingUserId, "household.rename", "household", householdId, {
      beforeJson: { name: household.name },
      afterJson: { name: dto.name },
    });
    return { id: householdId, name: dto.name };
  }

  /**
   * HH-001 "set member label" — the relationshipLabel shown in the member list (see
   * settings/household/page.tsx). Either the member themself, or an owner/adult member managing the
   * household, may set it — mirrors how `invite()`'s relationshipLabel is inviter-supplied at invite time
   * but nothing previously let it be corrected afterward (e.g. a typo, or a relationship that changed).
   */
  async setMemberLabel(householdId: string, membershipId: string, requestingUserId: string, dto: SetMemberLabelDto) {
    const requestorMembership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    const [target] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.id, membershipId), eq(schema.householdMemberships.householdId, householdId)))
      .limit(1);
    if (!target) throw new NotFoundException({ code: "MEMBERSHIP_NOT_FOUND", message: "Not found." });
    const isSelf = target.id === requestorMembership.id;
    const canManage = requestorMembership.role === "household_owner" || requestorMembership.role === "adult_member";
    if (!isSelf && !canManage) {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "You can only set your own member label." });
    }
    await this.db
      .update(schema.householdMemberships)
      .set({ relationshipLabel: dto.relationshipLabel })
      .where(eq(schema.householdMemberships.id, membershipId));
    await this.recordAudit(requestingUserId, "household.set_member_label", "household_membership", membershipId, {
      beforeJson: { relationshipLabel: target.relationshipLabel },
      afterJson: { relationshipLabel: dto.relationshipLabel },
    });
  }

  /**
   * HH-001 "remove" — an owner/adult member removing another active member. Immediate effect: every
   * access path that reads household membership (activeHouseholdIds, isActiveMember, assertOwnerOrAdult)
   * queries live status="active" rows with no caching layer in front of it, so removal is visible on the
   * very next request the removed user makes — there's no separate device/cache-invalidation step to
   * perform (this app has no resource_acl_cache yet; see HH-002's own audit notes on that gap).
   * Deliberately can't remove: yourself (use leave()), or the current household_owner/billing owner
   * (ownership must be transferred first via transferOwnership() — removing the owner outright would
   * strand the household without one, and orphan households.billingOwnerUserId's FK-referenced plan).
   */
  async removeMember(householdId: string, membershipId: string, requestingUserId: string) {
    const requestorMembership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (requestorMembership.role !== "household_owner" && requestorMembership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can remove other members." });
    }
    const [target] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.id, membershipId), eq(schema.householdMemberships.householdId, householdId)))
      .limit(1);
    if (!target) throw new NotFoundException({ code: "MEMBERSHIP_NOT_FOUND", message: "Not found." });
    if (target.status !== "active") {
      throw new BadRequestException({ code: "NOT_ACTIVE", message: "This member is not active." });
    }
    if (target.id === requestorMembership.id) {
      throw new BadRequestException({ code: "CANNOT_REMOVE_SELF", message: "Use leave instead of removing yourself." });
    }
    if (target.role === "household_owner") {
      throw new BadRequestException({ code: "OWNER_MUST_TRANSFER", message: "Transfer ownership before removing the household owner." });
    }
    await this.db
      .update(schema.householdMemberships)
      .set({ status: "removed", leftAt: new Date() })
      .where(eq(schema.householdMemberships.id, membershipId));
    await this.recordAudit(requestingUserId, "household.remove_member", "household_membership", membershipId, {
      beforeJson: { userId: target.userId, role: target.role, status: target.status },
    });
  }

  /**
   * HH-001 "transfer household ownership" — the resolution for leave()'s OWNER_MUST_TRANSFER: before
   * this method existed, an owner who wanted to leave had no way to stop being the owner, so leave() was a
   * dead end for every owner (confirmed live — leave() always 400s with OWNER_MUST_TRANSFER for the
   * household_owner role, and nothing in the controller/service offered a transfer path). Moves both the
   * `household_owner` role (the in-household authority ROLE_LABEL shows as "Owner") and
   * `households.billingOwnerUserId` (which plan/quota checks like assertHouseholdMemberQuota resolve
   * against) together, since today's UI/data model only has one "owner" concept — splitting role-owner
   * from billing-owner into independently transferable things isn't modeled anywhere yet.
   */
  async transferOwnership(householdId: string, requestingUserId: string, dto: TransferOwnershipDto) {
    const requestorMembership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (requestorMembership.role !== "household_owner") {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the current owner can transfer ownership." });
    }
    if (dto.targetUserId === requestingUserId) {
      throw new BadRequestException({ code: "CANNOT_TRANSFER_TO_SELF", message: "You already own this household." });
    }
    const [targetMembership] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          eq(schema.householdMemberships.userId, dto.targetUserId),
          eq(schema.householdMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!targetMembership) {
      throw new BadRequestException({ code: "NOT_A_MEMBER", message: "The new owner must be an active adult member of this household." });
    }
    if (targetMembership.role !== "adult_member") {
      throw new BadRequestException({ code: "INELIGIBLE_ROLE", message: "Ownership can only be transferred to an adult member." });
    }

    await this.db.transaction(async (tx) => {
      await tx.update(schema.householdMemberships).set({ role: "adult_member" }).where(eq(schema.householdMemberships.id, requestorMembership.id));
      await tx.update(schema.householdMemberships).set({ role: "household_owner" }).where(eq(schema.householdMemberships.id, targetMembership.id));
      await tx.update(schema.households).set({ billingOwnerUserId: dto.targetUserId, updatedAt: new Date() }).where(eq(schema.households.id, householdId));
    });
    await this.recordAudit(requestingUserId, "household.transfer_ownership", "household", householdId, {
      beforeJson: { ownerUserId: requestingUserId },
      afterJson: { ownerUserId: dto.targetUserId },
    });
    return { householdId, ownerUserId: dto.targetUserId };
  }

  /**
   * Unauthenticated by design (mirrors identity.service.ts's resetPassword token lookup) — the invitee may
   * not have an account yet, so the accept-invite web page needs to render "You've been invited to join
   * {householdName}" before any sign-in happens. Deliberately returns only enough to render that prompt,
   * not full household details.
   */
  async getInviteByToken(token: string) {
    const tokenHash = hashOpaqueToken(token);
    const [row] = await this.db
      .select({ membership: schema.householdMemberships, household: schema.households })
      .from(schema.householdMemberships)
      .innerJoin(schema.households, eq(schema.households.id, schema.householdMemberships.householdId))
      .where(eq(schema.householdMemberships.inviteTokenHash, tokenHash))
      .limit(1);
    if (!row || row.membership.status !== "invited" || !row.membership.inviteTokenExpiresAt || row.membership.inviteTokenExpiresAt < new Date()) {
      throw new BadRequestException({ code: "INVALID_INVITE_TOKEN", message: "This invite link is invalid or has expired." });
    }
    return { householdId: row.household.id, householdName: row.household.name, invitedEmail: row.membership.invitedEmail };
  }

  /**
   * Requires an authenticated session (unlike getInviteByToken) so there's a real userId to attach the
   * membership to. Also re-checks the seat quota — the household could have filled up between invite and
   * accept — and requires the signer's own email to match invitedEmail, since (unlike a password reset,
   * where only the account owner could ever have received the link) an invite link could plausibly be
   * forwarded to or opened by the wrong signed-in account.
   */
  async acceptInvite(token: string, requestingUserId: string) {
    const tokenHash = hashOpaqueToken(token);
    const [membership] = await this.db.select().from(schema.householdMemberships).where(eq(schema.householdMemberships.inviteTokenHash, tokenHash)).limit(1);
    if (!membership || membership.status !== "invited" || !membership.inviteTokenExpiresAt || membership.inviteTokenExpiresAt < new Date()) {
      throw new BadRequestException({ code: "INVALID_INVITE_TOKEN", message: "This invite link is invalid or has expired." });
    }
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, requestingUserId)).limit(1);
    if (!user || user.email !== membership.invitedEmail) {
      throw new ForbiddenException({ code: "INVITE_EMAIL_MISMATCH", message: "This invite was sent to a different email address. Sign in with that account to accept it." });
    }
    const [household] = await this.db.select().from(schema.households).where(eq(schema.households.id, membership.householdId)).limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });
    // No quota re-check here: assertHouseholdMemberQuota counts "invited" and "active" rows together (see
    // entitlements.service.ts), so this row's seat was already reserved the moment the invite was created
    // — re-checking here would double-count it against itself and could wrongly block acceptance right at
    // the limit (e.g. max=1 with only this one pending invite: rows.length(1) >= max(1) would throw, even
    // though accepting doesn't add a new row).

    await this.db
      .update(schema.householdMemberships)
      .set({ userId: requestingUserId, status: "active", joinedAt: new Date(), inviteTokenHash: null, inviteTokenExpiresAt: null })
      .where(eq(schema.householdMemberships.id, membership.id));
    await this.recordAudit(requestingUserId, "household.invite_accept", "household", membership.householdId, {
      afterJson: { membershipId: membership.id },
    });
    return { householdId: membership.householdId, membershipId: membership.id };
  }

  /**
   * HH-001 "decline" — the accept/decline pair's other half. Unauthenticated like getInviteByToken (not
   * acceptInvite): declining doesn't need to attach a userId to anything, and the invitee may not have an
   * account to sign into at all — the token itself is sufficient proof of intent, same reasoning as
   * getInviteByToken's own doc comment. Reuses status "removed" rather than a distinct "declined" value —
   * membershipStatusEnum only has invited/active/left/removed, and from every downstream consumer's
   * perspective (quota counting, member-list display) a declined invite should behave identically to a
   * revoked one: gone, not occupying a seat, safe to re-invite.
   */
  async declineInvite(token: string) {
    const tokenHash = hashOpaqueToken(token);
    const [membership] = await this.db.select().from(schema.householdMemberships).where(eq(schema.householdMemberships.inviteTokenHash, tokenHash)).limit(1);
    if (!membership || membership.status !== "invited" || !membership.inviteTokenExpiresAt || membership.inviteTokenExpiresAt < new Date()) {
      throw new BadRequestException({ code: "INVALID_INVITE_TOKEN", message: "This invite link is invalid or has expired." });
    }
    await this.db
      .update(schema.householdMemberships)
      .set({ status: "removed", inviteTokenHash: null, inviteTokenExpiresAt: null })
      .where(eq(schema.householdMemberships.id, membership.id));
    await this.recordAudit(membership.userId ?? membership.invitedEmail ?? "unknown", "household.invite_decline", "household", membership.householdId, {
      beforeJson: { membershipId: membership.id, invitedEmail: membership.invitedEmail },
    });
    return { householdId: membership.householdId };
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
    // Explicit column list, same reasoning as listMembers above — transitionInviteTokenHash is internal
    // accept-flow state, not something the household's own members need reflected back to them.
    return this.db
      .select({
        id: schema.dependentProfiles.id,
        householdId: schema.dependentProfiles.householdId,
        displayName: schema.dependentProfiles.displayName,
        birthDate: schema.dependentProfiles.birthDate,
        guardianUserIds: schema.dependentProfiles.guardianUserIds,
        hasOwnAccount: schema.dependentProfiles.hasOwnAccount,
        linkedUserId: schema.dependentProfiles.linkedUserId,
        transitionInvitedEmail: schema.dependentProfiles.transitionInvitedEmail,
        transitionInviteTokenExpiresAt: schema.dependentProfiles.transitionInviteTokenExpiresAt,
        createdAt: schema.dependentProfiles.createdAt,
      })
      .from(schema.dependentProfiles)
      .where(eq(schema.dependentProfiles.householdId, householdId));
  }

  /**
   * FAM-001 "later invite/transition path when appropriate" — starts a dependent-to-own-account transition
   * by emailing an accept link, same shape as invite() above (opaque token, hashed at rest, 7-day expiry,
   * pg_advisory_xact_lock'd on the household to close the identical seat-quota TOCTOU race invite() already
   * had). Deliberately admin/adult-member-only (see dto.ts's own doc comment on InviteDependentTransitionDto)
   * — a dependent profile has no session of its own to call this from anyway, since it "has no login
   * required" until this exact flow completes.
   */
  async inviteDependentTransition(householdId: string, dependentId: string, requestingUserId: string, dto: InviteDependentTransitionDto) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult household members can start a dependent's account transition." });
    }

    const { household, rawToken } = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${householdId}))`);

      const [household] = await tx.select().from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
      if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });

      const [dependent] = await tx
        .select()
        .from(schema.dependentProfiles)
        .where(and(eq(schema.dependentProfiles.id, dependentId), eq(schema.dependentProfiles.householdId, householdId)))
        .limit(1);
      if (!dependent) throw new NotFoundException({ code: "DEPENDENT_NOT_FOUND", message: "Dependent not found." });
      if (dependent.hasOwnAccount) {
        throw new BadRequestException({ code: "ALREADY_LINKED", message: "This dependent already has their own linked account." });
      }
      if (dependent.transitionInviteTokenHash && dependent.transitionInviteTokenExpiresAt && dependent.transitionInviteTokenExpiresAt > new Date()) {
        throw new BadRequestException({ code: "ALREADY_INVITED", message: "A transition invite for this dependent is already pending." });
      }

      // Same reasoning as invite()'s own quota check: accepting this invite adds a new household_memberships
      // row (unless the invited email already belongs to an active member — see acceptDependentTransition),
      // so the seat limit is enforced up front, at invite time.
      await this.entitlements.assertHouseholdMemberQuota(householdId, household.billingOwnerUserId);

      const rawToken = generateOpaqueToken();
      await tx
        .update(schema.dependentProfiles)
        .set({
          transitionInvitedEmail: dto.email,
          transitionInviteTokenHash: hashOpaqueToken(rawToken),
          transitionInviteTokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
        })
        .where(eq(schema.dependentProfiles.id, dependentId));

      return { household, rawToken };
    });

    const acceptUrl = `${loadEnv().WEB_APP_URL}/accept-dependent-invite?token=${rawToken}`;
    try {
      await this.mailer.send({
        to: dto.email,
        subject: `You've been invited to link your own Veynlo account for ${household.name}`,
        text: `A guardian in the "${household.name}" household on Veynlo has invited you to link your own account. You'll keep everything already on your profile, and gain independent sign-in access. Accept here (link expires in 7 days): ${acceptUrl}\n\nIf you weren't expecting this, you can safely ignore this email.`,
        html: `<p>A guardian in the "${escapeHtml(household.name)}" household on Veynlo has invited you to link your own account. You'll keep everything already on your profile, and gain independent sign-in access.</p><p><a href="${acceptUrl}">Accept the invite</a> (link expires in 7 days).</p><p>If you weren't expecting this, you can safely ignore this email.</p>`,
      });
    } catch (err) {
      this.logger.error(`Failed to send dependent-transition-invite email: ${String(err)}`);
    }

    await this.recordAudit(requestingUserId, "household.dependent_transition_invite", "dependent_profile", dependentId, {
      afterJson: { invitedEmail: dto.email, householdId },
    });
    return { id: dependentId };
  }

  /**
   * HH-001/FAM-001 "revoke" counterpart for a dependent's still-pending transition invite — mirrors
   * revokeInvite()'s shape (clears the token so a copy of the old email can never be used, leaves
   * transitionInvitedEmail in place for history, frees the dependent up for a fresh invite immediately).
   */
  async revokeDependentTransitionInvite(householdId: string, dependentId: string, requestingUserId: string) {
    const membership = await this.assertOwnerOrAdult(householdId, requestingUserId);
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult household members can revoke a dependent's transition invite." });
    }
    const [dependent] = await this.db
      .select()
      .from(schema.dependentProfiles)
      .where(and(eq(schema.dependentProfiles.id, dependentId), eq(schema.dependentProfiles.householdId, householdId)))
      .limit(1);
    if (!dependent) throw new NotFoundException({ code: "DEPENDENT_NOT_FOUND", message: "Dependent not found." });
    if (!dependent.transitionInviteTokenHash) {
      throw new BadRequestException({ code: "NOT_PENDING", message: "This dependent has no pending transition invite." });
    }
    await this.db
      .update(schema.dependentProfiles)
      .set({ transitionInviteTokenHash: null, transitionInviteTokenExpiresAt: null })
      .where(eq(schema.dependentProfiles.id, dependentId));
    await this.recordAudit(requestingUserId, "household.dependent_transition_revoke", "dependent_profile", dependentId, {
      beforeJson: { invitedEmail: dependent.transitionInvitedEmail },
    });
  }

  /**
   * Unauthenticated by design, same reasoning as getInviteByToken — the invitee (the dependent, now old
   * enough to sign up on their own) may not have an account yet.
   */
  async getDependentTransitionInviteByToken(token: string) {
    const tokenHash = hashOpaqueToken(token);
    const [row] = await this.db
      .select({ dependent: schema.dependentProfiles, household: schema.households })
      .from(schema.dependentProfiles)
      .innerJoin(schema.households, eq(schema.households.id, schema.dependentProfiles.householdId))
      .where(eq(schema.dependentProfiles.transitionInviteTokenHash, tokenHash))
      .limit(1);
    if (
      !row ||
      row.dependent.hasOwnAccount ||
      !row.dependent.transitionInviteTokenExpiresAt ||
      row.dependent.transitionInviteTokenExpiresAt < new Date()
    ) {
      throw new BadRequestException({ code: "INVALID_INVITE_TOKEN", message: "This invite link is invalid or has expired." });
    }
    return {
      householdId: row.household.id,
      householdName: row.household.name,
      dependentDisplayName: row.dependent.displayName,
      invitedEmail: row.dependent.transitionInvitedEmail,
    };
  }

  /**
   * FAM-001's actual link step. Requires an authenticated session (unlike the peek above) and — like
   * acceptInvite — requires the signer's own email to match the invited one. Data-continuity decision: the
   * dependentProfiles row is kept (not deleted) and every existing record that already references it by
   * `dependentProfileId`/`dependentId` (health logistics, memories, school, assets, people — see those
   * schemas' own FKs onto this table) stays exactly as visible as it always was; nothing is re-owned onto
   * the new user account. What changes going forward is *access*: the newly linked user gets a real,
   * independent `household_memberships` row (role `dependent_profile` — the same restricted-but-genuine
   * membership role emergency-binder.service.ts already gates non-adult settings edits on) so they become a
   * normal, visible household member rather than a profile someone else manages, without silently
   * inheriting adult-level admin rights (inviting, removing members, renaming the household, etc. still
   * require `household_owner`/`adult_member`). If the invited email happens to already belong to an active
   * member of this household (e.g. re-linking after the dependent was independently invited some other
   * way), their existing membership/role is left untouched rather than downgraded.
   */
  async acceptDependentTransition(token: string, requestingUserId: string) {
    const tokenHash = hashOpaqueToken(token);
    const [dependent] = await this.db.select().from(schema.dependentProfiles).where(eq(schema.dependentProfiles.transitionInviteTokenHash, tokenHash)).limit(1);
    if (!dependent || dependent.hasOwnAccount || !dependent.transitionInviteTokenExpiresAt || dependent.transitionInviteTokenExpiresAt < new Date()) {
      throw new BadRequestException({ code: "INVALID_INVITE_TOKEN", message: "This invite link is invalid or has expired." });
    }
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, requestingUserId)).limit(1);
    if (!user || user.email !== dependent.transitionInvitedEmail) {
      throw new ForbiddenException({ code: "INVITE_EMAIL_MISMATCH", message: "This invite was sent to a different email address. Sign in with that account to accept it." });
    }
    const [household] = await this.db.select().from(schema.households).where(eq(schema.households.id, dependent.householdId)).limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });

    const membershipId = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${dependent.householdId}))`);

      // Re-check under the lock: another accept (or a revoke) could have landed between the reads above and
      // acquiring the lock.
      const [current] = await tx.select().from(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dependent.id)).limit(1);
      if (!current || current.hasOwnAccount || current.transitionInviteTokenHash !== tokenHash) {
        throw new BadRequestException({ code: "INVALID_INVITE_TOKEN", message: "This invite link is invalid or has expired." });
      }

      await tx
        .update(schema.dependentProfiles)
        .set({
          hasOwnAccount: true,
          linkedUserId: requestingUserId,
          transitionInviteTokenHash: null,
          transitionInviteTokenExpiresAt: null,
        })
        .where(eq(schema.dependentProfiles.id, current.id));

      const [existingMembership] = await tx
        .select({ id: schema.householdMemberships.id })
        .from(schema.householdMemberships)
        .where(
          and(
            eq(schema.householdMemberships.householdId, current.householdId),
            eq(schema.householdMemberships.userId, requestingUserId),
            eq(schema.householdMemberships.status, "active"),
          ),
        )
        .limit(1);
      if (existingMembership) {
        return existingMembership.id;
      }

      // No quota re-check race window here worth closing with the advisory lock alone: assertHouseholdMemberQuota
      // still runs on its own connection (see invite()'s identical note), but this whole block already holds
      // the per-household lock any concurrent invite()/acceptDependentTransition/acceptInvite call also takes.
      await this.entitlements.assertHouseholdMemberQuota(current.householdId, household.billingOwnerUserId);
      const newMembershipId = generateId("membership");
      await tx.insert(schema.householdMemberships).values({
        id: newMembershipId,
        householdId: current.householdId,
        userId: requestingUserId,
        role: "dependent_profile",
        relationshipLabel: current.displayName,
        status: "active",
        joinedAt: new Date(),
      });
      return newMembershipId;
    });

    await this.recordAudit(requestingUserId, "household.dependent_transition_accept", "dependent_profile", dependent.id, {
      afterJson: { linkedUserId: requestingUserId, membershipId },
    });
    return { householdId: dependent.householdId, dependentId: dependent.id, membershipId };
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
