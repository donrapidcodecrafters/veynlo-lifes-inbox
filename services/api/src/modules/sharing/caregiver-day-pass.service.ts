import { createHash, randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { CaregiverDayPassScope, CreateCaregiverDayPassDto } from "./caregiver-day-pass.dto";
import { SharingService } from "./sharing.service";

/**
 * §35 SHARE-005 "Caregiver/day pass" — "Time-bound collection for caregiver logistics. Schedule,
 * contacts, access instructions, pet/kid tasks; automatically expires." Deliberately distinct from
 * FAM-006's `caregiverDelegations` (household.service.ts grantDelegation/listDelegations/revokeDelegation)
 * — that feature is an ONGOING, ACCOUNT-HOLDING household member getting scoped read access into the
 * household's own domain tables (lists/tasks/bills/etc, enforced by each domain's own
 * `delegatedHouseholdIds` OR-branch). This is the opposite shape on every axis: a MANDATORY expiry, no
 * Veynlo account required at all (same unauthenticated-token posture as `shareLinks`), and a fixed,
 * purpose-built read-only packet assembled fresh at redemption time — never raw access into any domain
 * table's own list/detail endpoints. See caregiverDayPasses' own schema doc comment
 * (packages/db/src/schema/sharing.ts) for the full field-by-field reasoning.
 */
@Injectable()
export class CaregiverDayPassService {
  private dummyPasscodeHashCache: Promise<string> | null = null;
  private dummyPasscodeHash(): Promise<string> {
    if (!this.dummyPasscodeHashCache) this.dummyPasscodeHashCache = argon2.hash(randomBytes(16).toString("hex"));
    return this.dummyPasscodeHashCache;
  }

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SharingService) private readonly sharing: SharingService,
  ) {}

  /** Mirrors EmergencyBinderService's own assertActiveMember/assertAdultMember (queried directly rather
   * than through HouseholdService — same reasoning: this only needs the one membership check, not that
   * service's much larger surface). Household roster/logistics is shared family information any adult
   * member should be able to hand a sitter a pass for, not just the household owner. */
  private async assertAdultMember(householdId: string, userId: string): Promise<void> {
    const [membership] = await this.db
      .select({ role: schema.householdMemberships.role })
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.userId, userId), eq(schema.householdMemberships.status, "active")))
      .limit(1);
    if (!membership) throw new ForbiddenException({ code: "NOT_A_MEMBER", message: "You are not a member of this household." });
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can manage caregiver day passes." });
    }
  }

  async create(householdId: string, requestingUserId: string, dto: CreateCaregiverDayPassDto): Promise<{ id: string; token: string }> {
    await this.assertAdultMember(householdId, requestingUserId);
    const token = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const passcodeHash = dto.passcode ? await argon2.hash(dto.passcode) : null;
    const id = generateId("caregiverDayPass");
    await this.db.insert(schema.caregiverDayPasses).values({
      id,
      householdId,
      createdByUserId: requestingUserId,
      label: dto.label,
      tokenHash,
      passcodeHash,
      scopes: dto.scopes,
      expiresAt: new Date(Date.now() + dto.expiresInHours * 60 * 60 * 1000),
    });
    return { id, token };
  }

  /** Never returns tokenHash/passcodeHash — same "already shown once, at creation" posture as
   * SharingService.listShareLinks. */
  async list(householdId: string, requestingUserId: string) {
    await this.assertAdultMember(householdId, requestingUserId);
    const rows = await this.db
      .select({
        id: schema.caregiverDayPasses.id,
        label: schema.caregiverDayPasses.label,
        scopes: schema.caregiverDayPasses.scopes,
        startsAt: schema.caregiverDayPasses.startsAt,
        expiresAt: schema.caregiverDayPasses.expiresAt,
        revokedAt: schema.caregiverDayPasses.revokedAt,
        expiredAt: schema.caregiverDayPasses.expiredAt,
        passcodeHash: schema.caregiverDayPasses.passcodeHash,
        createdAt: schema.caregiverDayPasses.createdAt,
      })
      .from(schema.caregiverDayPasses)
      .where(eq(schema.caregiverDayPasses.householdId, householdId));
    return rows.map((r) => ({ ...r, hasPasscode: r.passcodeHash != null, passcodeHash: undefined }));
  }

  /** "Caregiver access ends mid-day" (SHARE-001's own failure-state list, which SHARE-005 shares) — early,
   * owner-initiated revocation, distinct from the scheduled expiry sweep below. */
  async revoke(householdId: string, passId: string, requestingUserId: string): Promise<void> {
    await this.assertAdultMember(householdId, requestingUserId);
    const [pass] = await this.db
      .select({ id: schema.caregiverDayPasses.id, revokedAt: schema.caregiverDayPasses.revokedAt })
      .from(schema.caregiverDayPasses)
      .where(and(eq(schema.caregiverDayPasses.id, passId), eq(schema.caregiverDayPasses.householdId, householdId)))
      .limit(1);
    if (!pass) throw new NotFoundException({ code: "DAY_PASS_NOT_FOUND", message: "Not found." });
    if (pass.revokedAt) throw new BadRequestException({ code: "ALREADY_REVOKED", message: "This pass was already revoked." });
    await this.db.update(schema.caregiverDayPasses).set({ revokedAt: new Date() }).where(eq(schema.caregiverDayPasses.id, passId));
  }

  /**
   * The recurring tick's actual work (QueueProducerService.scheduleRecurringCaregiverDayPassScan /
   * worker-main.ts's caregiverDayPassScanWorker) — every pass whose `expiresAt` has passed and isn't
   * already revoked/marked expired gets `expiredAt` stamped. The redemption path (`access`, below) also
   * checks `expiresAt` live regardless of this sweep having run yet — same defense-in-depth as every other
   * expiring token in this codebase — so this sweep is about the UI/audit trail being accurate ("expired"
   * vs. still showing as pending), not the actual access control.
   */
  async expireDuePasses(): Promise<number> {
    const result = await this.db
      .update(schema.caregiverDayPasses)
      .set({ expiredAt: new Date() })
      .where(and(lte(schema.caregiverDayPasses.expiresAt, new Date()), isNull(schema.caregiverDayPasses.expiredAt), isNull(schema.caregiverDayPasses.revokedAt)))
      .returning({ id: schema.caregiverDayPasses.id });
    return result.length;
  }

  /**
   * Public, unauthenticated redemption (mirrors SharingService.resolveShareLink's own doc comment on
   * timing/error-message discipline: an unknown token and a wrong passcode must be indistinguishable, both
   * in message and in latency). Returns the redacted logistics packet directly (unlike resolveShareLink,
   * which just returns a (resourceType, resourceId) pair for a caller to dispatch further) — a day pass
   * has exactly one content shape, not one per resource type, so there's no dispatch step needed.
   */
  async access(token: string, passcode: string | undefined) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const [pass] = await this.db.select().from(schema.caregiverDayPasses).where(eq(schema.caregiverDayPasses.tokenHash, tokenHash)).limit(1);
    if (!pass || pass.revokedAt || pass.expiresAt < new Date()) {
      await argon2.verify(await this.dummyPasscodeHash(), passcode ?? "");
      throw new NotFoundException({ code: "DAY_PASS_NOT_FOUND", message: "This pass is invalid or has expired." });
    }
    if (pass.passcodeHash) {
      if (!passcode || !(await argon2.verify(pass.passcodeHash, passcode))) {
        throw new ForbiddenException({ code: "PASSCODE_REQUIRED", message: "This pass needs a passcode." });
      }
    }
    await this.sharing.recordAnonymousAccess("caregiver_day_pass", pass.id);
    return this.buildPacket(pass.householdId, pass.scopes as CaregiverDayPassScope[], pass.label, pass.expiresAt);
  }

  /**
   * Assembles exactly the scopes the household chose (see caregiver-day-pass.dto.ts's own doc comment on
   * the recognized values) — never anything outside them, and never the household's full emergency-binder
   * aggregate (EmergencyBinderService.getBinder), which is a materially higher-trust surface (identity
   * records, vehicle VINs, etc.) than a sitter/house-sitter should ever see.
   */
  private async buildPacket(householdId: string, scopes: CaregiverDayPassScope[], label: string, expiresAt: Date) {
    const [household] = await this.db.select({ id: schema.households.id, name: schema.households.name, emergencyInstructions: schema.households.emergencyInstructions }).from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
    if (!household) throw new NotFoundException({ code: "DAY_PASS_NOT_FOUND", message: "This pass is invalid or has expired." });

    const packet: Record<string, unknown> = { label, householdName: household.name, expiresAt };

    if (scopes.includes("instructions")) {
      packet.instructions = household.emergencyInstructions;
    }
    if (scopes.includes("contacts")) {
      const members = await this.db
        .select({ displayName: schema.users.displayName, relationshipLabel: schema.householdMemberships.relationshipLabel })
        .from(schema.householdMemberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.householdMemberships.userId))
        .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.status, "active")));
      packet.contacts = members;
    }
    if (scopes.includes("schedule")) {
      const now = new Date();
      const events = await this.db
        .select({ title: schema.calendarEvents.title, start: schema.calendarEvents.start, startSort: schema.calendarEvents.startSort, isAllDay: schema.calendarEvents.isAllDay })
        .from(schema.calendarEvents)
        .where(and(eq(schema.calendarEvents.householdId, householdId), ne(schema.calendarEvents.visibility, "private")));
      packet.schedule = events.filter((e) => e.startSort && e.startSort >= now && e.startSort <= expiresAt);
    }
    if (scopes.includes("pets")) {
      const pets = await this.db
        .select({ id: schema.petProfiles.id, label: schema.petProfiles.label, species: schema.petProfiles.species, breed: schema.petProfiles.breed })
        .from(schema.petProfiles)
        .where(and(eq(schema.petProfiles.householdId, householdId), isNull(schema.petProfiles.deletedAt), ne(schema.petProfiles.lifecycleStatus, "deceased")));
      const petIds = pets.map((p) => p.id);
      const refills =
        petIds.length > 0
          ? await this.db
              .select({ petProfileId: schema.refillReminders.petProfileId, medicationName: schema.refillReminders.medicationName })
              .from(schema.refillReminders)
              .where(and(inArray(schema.refillReminders.petProfileId, petIds), isNull(schema.refillReminders.deletedAt)))
          : [];
      packet.pets = pets.map((p) => ({ ...p, medications: refills.filter((r) => r.petProfileId === p.id).map((r) => r.medicationName) }));
    }
    if (scopes.includes("dependents")) {
      const dependents = await this.db.select({ id: schema.dependentProfiles.id, displayName: schema.dependentProfiles.displayName }).from(schema.dependentProfiles).where(eq(schema.dependentProfiles.householdId, householdId));
      packet.dependents = dependents;
    }
    return packet;
  }
}
