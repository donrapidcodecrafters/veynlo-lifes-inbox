import { BadRequestException, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { CreateDependentDto, CreateHouseholdDto, InviteMemberDto } from "./dto";

@Injectable()
export class HouseholdService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

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
  }
}
