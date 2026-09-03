import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { IdentityService } from "../identity/identity.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { SharingService } from "./sharing.service";
import type { CreateLegacyReleaseConfigDto, LegacyReleaseCategory } from "./legacy-release.dto";

/**
 * §35 SHARE-006 "Future trusted delegate / legacy release" — spec's exact text: "Optional preconfigured
 * release of selected information under a carefully verified process... Requires separate legal/security
 * design; no automatic account takeover. Release criteria, waiting period, multi-party verification and
 * revocation must be explicit."
 *
 * What this builds, in full: the owner's own multi-step setup (a draft, then an explicit step-up-password
 * "arm" confirmation — see `confirm` below), a two-operator admin-initiated OR inactivity-triggered release
 * with a mandatory owner-cancellable waiting period (`initiateRelease`/`cancelPendingRelease`/
 * `finalizeRelease` — the "multi-party verification" the spec calls for: one operator starts the clock, the
 * owner has the whole waiting period to prove they're still there and cancel it, and only a SEPARATE
 * superadmin-role operator can finalize once that period has actually elapsed), and redemption of exactly
 * the owner-chosen categories.
 *
 * Automatic "prolonged inactivity" detection (`scanInactivity`, run off a recurring queue tick — see
 * QueueProducerService.scheduleRecurringLegacyReleaseInactivityScan / worker-main.ts): reads the REAL
 * login/session activity signal the identity module now maintains (`users.lastActiveAt` — updated at
 * sign-in, token refresh, and ordinary authenticated requests; see identity.service.ts's issueSession/
 * refreshSession and auth.guard.ts's own doc comments) against each armed config's own owner-chosen
 * `inactivityThresholdDays`. Two effects, both idempotent across ticks:
 *   - at WARNING_THRESHOLD_FRACTION (75%) of the threshold, an "are you still there?" email goes to the
 *     owner (via NotificationDeliveryService — same chokepoint every other notification in this codebase
 *     goes through) — sent at most once per inactivity spell (`inactivityWarningSentAt` guards it, and is
 *     cleared once real activity resumes so a LATER spell can warn again).
 *   - at 100% of the threshold, `beginWaitingPeriod` runs with a "system" actor rather than a human admin's
 *     id — the EXACT same waiting-period start `initiateRelease` performs for a manual admin action, never
 *     a shortcut around it. The superadmin-gated `finalizeRelease` step is completely untouched by any of
 *     this: nothing here ever finalizes a release, only starts the same clock a human admin could also
 *     start, and the owner keeps the same cancel-anytime-before-release escape hatch either way.
 *
 * Draws from the SAME household aggregate EmergencyBinderService.getBinder does (household roster,
 * vehicles, properties, pets, identity records, documents, medications/instructions) rather than arbitrary
 * per-resource sharing (SharingService's resourceGrants/shareLinks) — "release selected information" here
 * means the life-continuity bundle a legacy contact would actually need, not an arbitrary shopping list or
 * saved memory. Queries the underlying tables directly, same "this only needs read access to a few tables,
 * not a whole other service's surface" reasoning EmergencyBinderService's own doc comment gives.
 */
@Injectable()
export class LegacyReleaseService {
  private readonly logger = new Logger(LegacyReleaseService.name);

  /** "Say 75%" — the earlier grace-warning point as a fraction of the owner's own `inactivityThresholdDays`. */
  private static readonly WARNING_THRESHOLD_FRACTION = 0.75;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(NotificationDeliveryService) private readonly notificationDelivery: NotificationDeliveryService,
  ) {}

  private async recordAudit(actorType: "user" | "support_agent" | "system", actorId: string, action: string, resourceId: string, extra: { beforeJson?: unknown; afterJson?: unknown } = {}) {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType,
      actorId,
      action,
      resourceType: "legacy_release_config",
      resourceId,
      beforeJson: extra.beforeJson,
      afterJson: extra.afterJson,
      result: "success",
    });
  }

  private async loadOwned(id: string, ownerUserId: string) {
    const [config] = await this.db.select().from(schema.legacyReleaseConfigs).where(and(eq(schema.legacyReleaseConfigs.id, id), eq(schema.legacyReleaseConfigs.ownerUserId, ownerUserId))).limit(1);
    if (!config) throw new NotFoundException({ code: "LEGACY_RELEASE_NOT_FOUND", message: "Not found." });
    return config;
  }

  // --- Owner setup (draft -> armed), and revocation --------------------------------------------------

  async create(ownerUserId: string, dto: CreateLegacyReleaseConfigDto) {
    if (dto.householdId) {
      const [membership] = await this.db
        .select({ id: schema.householdMemberships.id })
        .from(schema.householdMemberships)
        .where(and(eq(schema.householdMemberships.householdId, dto.householdId), eq(schema.householdMemberships.userId, ownerUserId), eq(schema.householdMemberships.status, "active")))
        .limit(1);
      if (!membership) throw new BadRequestException({ code: "NOT_A_MEMBER", message: "You are not a member of that household." });
    }
    const id = generateId("legacyReleaseConfig");
    await this.db.insert(schema.legacyReleaseConfigs).values({
      id,
      ownerUserId,
      householdId: dto.householdId ?? null,
      trustedContactEmail: dto.trustedContactEmail,
      categories: dto.categories,
      waitingPeriodDays: dto.waitingPeriodDays,
      inactivityThresholdDays: dto.inactivityThresholdDays ?? null,
      status: "draft",
    });
    await this.recordAudit("user", ownerUserId, "legacy_release.create_draft", id, { afterJson: { trustedContactEmail: dto.trustedContactEmail, categories: dto.categories } });
    return { id };
  }

  async list(ownerUserId: string) {
    return this.db.select().from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.ownerUserId, ownerUserId));
  }

  /**
   * The "clear, explicit multi-step confirmation... to set up" the task calls for: a draft alone does
   * nothing (no release path ever reads a "draft"-status config — see initiateRelease's own status check)
   * — arming requires a fresh step-up password, the same §28.9 mechanism EmergencyBinderService.getBinder
   * gates the aggregated packet view behind, re-verified here rather than trusted from session state.
   */
  async confirm(id: string, ownerUserId: string, password: string | undefined) {
    const config = await this.loadOwned(id, ownerUserId);
    if (config.status !== "draft") {
      throw new BadRequestException({ code: "NOT_DRAFT", message: "Only a draft configuration can be confirmed." });
    }
    await this.identity.verifyStepUpPassword(ownerUserId, password);
    await this.db.update(schema.legacyReleaseConfigs).set({ status: "armed", confirmedAt: new Date(), updatedAt: new Date() }).where(eq(schema.legacyReleaseConfigs.id, id));
    await this.recordAudit("user", ownerUserId, "legacy_release.confirm", id);
    return { id, status: "armed" };
  }

  /** "Revocation must be explicit" — deliberately no step-up gate: revoking access should always be at
   * least as easy as granting it, same posture as every other revoke path in this codebase (resourceGrants/
   * shareLinks/caregiverDayPasses). Works from any non-released status. */
  async revoke(id: string, ownerUserId: string) {
    const config = await this.loadOwned(id, ownerUserId);
    if (config.status === "released") {
      throw new BadRequestException({ code: "ALREADY_RELEASED", message: "This has already been released and can no longer be revoked." });
    }
    if (config.status === "revoked") {
      throw new BadRequestException({ code: "ALREADY_REVOKED", message: "This was already revoked." });
    }
    await this.db.update(schema.legacyReleaseConfigs).set({ status: "revoked", revokedAt: new Date(), updatedAt: new Date() }).where(eq(schema.legacyReleaseConfigs.id, id));
    await this.recordAudit("user", ownerUserId, "legacy_release.revoke", id, { beforeJson: { status: config.status } });
    return { id, status: "revoked" };
  }

  /**
   * The owner's safety valve during a pending release's waiting period — "no automatic account takeover"
   * in practice: as long as the owner can still sign in and act, they can always pull a release back to
   * "armed" before it finalizes. Deliberately no step-up gate, same reasoning as revoke() above — this is
   * the OWNER cancelling something ELSE initiated, not authorizing something new.
   */
  async cancelPendingRelease(id: string, ownerUserId: string) {
    const config = await this.loadOwned(id, ownerUserId);
    if (config.status !== "pending_release") {
      throw new BadRequestException({ code: "NOT_PENDING", message: "This isn't currently pending release." });
    }
    await this.db
      .update(schema.legacyReleaseConfigs)
      .set({ status: "armed", releaseInitiatedByAdminId: null, releaseInitiatedAt: null, releaseEligibleAt: null, updatedAt: new Date() })
      .where(eq(schema.legacyReleaseConfigs.id, id));
    await this.recordAudit("user", ownerUserId, "legacy_release.cancel_pending", id);
    return { id, status: "armed" };
  }

  // --- Admin-operated release (the "carefully verified process" / "multi-party verification") ---------

  /**
   * First of the two required admin actions. Any admin operator (AdminGuard — "support" role included) may
   * start the waiting period, but never skip it: `releaseEligibleAt` is always `now + waitingPeriodDays`,
   * the owner's OWN configured value, never shortened. Thin wrapper over `beginWaitingPeriod` — see that
   * method's own doc comment for the shared logic this has in common with `scanInactivity`'s
   * system-triggered start.
   */
  async initiateRelease(id: string, actingAdminId: string) {
    return this.beginWaitingPeriod(id, { actorType: "support_agent", actorId: actingAdminId });
  }

  /**
   * The one real state transition behind BOTH release triggers this service supports — a human admin
   * calling `initiateRelease`, and `scanInactivity` calling this directly once an armed config's owner
   * crosses their own configured inactivity threshold. Identical outcome either way: `releaseEligibleAt` is
   * always `now + waitingPeriodDays`, the owner's own configured value, never shortened or skipped — the
   * ONLY thing that differs is which actor the audit trail records, so support/legal can always tell "a
   * human operator decided this" apart from "the owner's own configured inactivity rule fired."
   */
  private async beginWaitingPeriod(id: string, actor: { actorType: "support_agent" | "system"; actorId: string }) {
    const [config] = await this.db.select().from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id)).limit(1);
    if (!config) throw new NotFoundException({ code: "LEGACY_RELEASE_NOT_FOUND", message: "Not found." });
    if (config.status !== "armed") {
      throw new BadRequestException({ code: "NOT_ARMED", message: "Only an armed configuration can enter its release waiting period." });
    }
    const releaseEligibleAt = new Date(Date.now() + config.waitingPeriodDays * 24 * 60 * 60 * 1000);
    await this.db
      .update(schema.legacyReleaseConfigs)
      .set({
        status: "pending_release",
        // Null for a system-triggered start — there's no admin operator to name, and this column already
        // doubles as that distinction (see the schema's own doc comment); the audit event's actorType/
        // action below is the authoritative record either way.
        releaseInitiatedByAdminId: actor.actorType === "support_agent" ? actor.actorId : null,
        releaseInitiatedAt: new Date(),
        releaseEligibleAt,
        inactivityWarningSentAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.legacyReleaseConfigs.id, id));
    await this.recordAudit(
      actor.actorType,
      actor.actorId,
      actor.actorType === "system" ? "legacy_release.auto_initiate" : "legacy_release.initiate",
      id,
      { afterJson: { releaseEligibleAt } },
    );
    return { id, status: "pending_release" as const, releaseEligibleAt };
  }

  /**
   * Second, DISTINCT required admin action, and the only one gated to the superadmin role
   * (`@UseGuards(AdminGuard, SuperAdminGuard)` on the controller route) — the actual "multi-party" split:
   * one operator (any support agent) can start the clock, but finalizing an irreversible information
   * release to someone outside the account needs the higher bar. Refuses outright if the waiting period
   * hasn't actually elapsed yet, regardless of who's asking — this is the one check that can never be
   * bypassed by role.
   */
  async finalizeRelease(id: string, actingAdminId: string) {
    const [config] = await this.db.select().from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.id, id)).limit(1);
    if (!config) throw new NotFoundException({ code: "LEGACY_RELEASE_NOT_FOUND", message: "Not found." });
    if (config.status !== "pending_release" || !config.releaseEligibleAt) {
      throw new BadRequestException({ code: "NOT_PENDING", message: "This isn't currently pending release." });
    }
    if (config.releaseEligibleAt > new Date()) {
      throw new ForbiddenException({ code: "WAITING_PERIOD_NOT_ELAPSED", message: "The waiting period hasn't elapsed yet." });
    }
    const token = randomBytes(24).toString("base64url");
    const releaseTokenHash = createHash("sha256").update(token).digest("hex");
    await this.db
      .update(schema.legacyReleaseConfigs)
      .set({ status: "released", releaseFinalizedByAdminId: actingAdminId, releasedAt: new Date(), releaseTokenHash, updatedAt: new Date() })
      .where(eq(schema.legacyReleaseConfigs.id, id));
    await this.recordAudit("support_agent", actingAdminId, "legacy_release.finalize", id);
    // The raw token is returned exactly once, here — same "never stored, only its hash is" posture as
    // shareLinks/caregiverDayPasses. Actually notifying the trusted contact (e.g. by email) is left to the
    // real-world verified process alongside the legal/security steps spec's own text calls out ("requires
    // separate legal/security design") — outside this pass's scope.
    return { id, status: "released", trustedContactEmail: config.trustedContactEmail, token };
  }

  // --- Automatic inactivity trigger (the recurring scan job) -------------------------------------------

  /**
   * Called from the recurring `legacy-release-inactivity-scan` queue tick (see
   * QueueProducerService.scheduleRecurringLegacyReleaseInactivityScan / worker-main.ts), mirroring
   * RecallMonitorService.scanAll's identical "one no-payload processor does its own lookup, then loops"
   * shape. Only ever looks at `armed` configs with a real owner-chosen `inactivityThresholdDays` — a draft,
   * a config with no inactivity trigger configured at all, or one already pending/released/revoked is never
   * touched here, regardless of how long its owner has been gone.
   *
   * Each config is handled independently and defensively (a failure on one config is logged and skipped,
   * never allowed to abort the whole tick) — same "don't let one bad row stop the scan" posture as every
   * other per-item loop in this codebase (e.g. RecallMonitorService.scanAll's own checkVehicle/
   * checkHomeAsset calls).
   */
  async scanInactivity(): Promise<{ warned: number; triggered: number }> {
    const candidates = await this.db
      .select({
        id: schema.legacyReleaseConfigs.id,
        ownerUserId: schema.legacyReleaseConfigs.ownerUserId,
        inactivityThresholdDays: schema.legacyReleaseConfigs.inactivityThresholdDays,
        inactivityWarningSentAt: schema.legacyReleaseConfigs.inactivityWarningSentAt,
        trustedContactEmail: schema.legacyReleaseConfigs.trustedContactEmail,
        lastActiveAt: schema.users.lastActiveAt,
      })
      .from(schema.legacyReleaseConfigs)
      .innerJoin(schema.users, eq(schema.users.id, schema.legacyReleaseConfigs.ownerUserId))
      .where(and(eq(schema.legacyReleaseConfigs.status, "armed"), isNotNull(schema.legacyReleaseConfigs.inactivityThresholdDays)));

    let warned = 0;
    let triggered = 0;
    for (const candidate of candidates) {
      try {
        const thresholdDays = candidate.inactivityThresholdDays!; // guaranteed by the isNotNull filter above
        const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
        const warningMs = thresholdMs * LegacyReleaseService.WARNING_THRESHOLD_FRACTION;
        const inactiveMs = Date.now() - candidate.lastActiveAt.getTime();

        if (inactiveMs >= thresholdMs) {
          // The owner never came back — do exactly what a human admin's initiateRelease does, as "system".
          await this.beginWaitingPeriod(candidate.id, { actorType: "system", actorId: "legacy-release-inactivity-monitor" });
          triggered++;
          continue;
        }

        if (inactiveMs >= warningMs) {
          if (!candidate.inactivityWarningSentAt) {
            await this.sendInactivityWarning(candidate.id, candidate.ownerUserId, candidate.trustedContactEmail, thresholdDays);
            warned++;
          }
        } else if (candidate.inactivityWarningSentAt) {
          // Real activity since the warning was sent (the owner signed back in, which bumped
          // users.lastActiveAt — see auth.guard.ts/identity.service.ts) — reset the clock so a LATER
          // inactivity spell for this same still-armed config can warn again.
          await this.db
            .update(schema.legacyReleaseConfigs)
            .set({ inactivityWarningSentAt: null, updatedAt: new Date() })
            .where(eq(schema.legacyReleaseConfigs.id, candidate.id));
        }
      } catch (err) {
        this.logger.error(`legacy-release inactivity scan failed for config ${candidate.id}: ${String((err as Error)?.message ?? err)}`);
      }
    }
    return { warned, triggered };
  }

  /**
   * The "are you still there?" grace mechanism the spec's "no automatic account takeover" posture calls
   * for in practice — a real chance to reset the clock (by simply signing back in, which bumps
   * `users.lastActiveAt`) before `scanInactivity` ever starts the actual waiting period. Goes out over
   * email specifically (not push) via NotificationDeliveryService.createAndEnqueue, the exact chokepoint
   * every other notification in this codebase funnels through — same "critical" priority tier as an
   * overdue-bill/confirmed-recall attention item (AttentionService's own call site), since missing this one
   * has real consequences an inactive owner needs to see even through quiet hours/digest-only preferences.
   * dedupeKey is anchored to the owner's CURRENT `lastActiveAt` value (fixed for the whole inactivity spell,
   * changes once they come back and go inactive again later) so createAndEnqueue's own existence-based
   * dedup doesn't permanently block a warning for a future, separate inactivity spell on the same config.
   */
  private async sendInactivityWarning(configId: string, ownerUserId: string, trustedContactEmail: string, thresholdDays: number): Promise<void> {
    const [owner] = await this.db.select({ lastActiveAt: schema.users.lastActiveAt }).from(schema.users).where(eq(schema.users.id, ownerUserId)).limit(1);
    const anchor = owner?.lastActiveAt?.getTime() ?? Date.now();
    await this.notificationDelivery.createAndEnqueue({
      ownerUserId,
      dedupeKey: `legacy-release-inactivity-warning:${configId}:${anchor}`,
      priority: "critical",
      channel: "email",
      title: "Still there? Your legacy release is about to start",
      body:
        `You've been inactive for a while. If you don't sign back in soon, your legacy release to ${trustedContactEmail} ` +
        `will begin its mandatory waiting period once you've been inactive for ${thresholdDays} days total. ` +
        `Signing in resets this clock — nothing else needs to change.`,
    });
    await this.db
      .update(schema.legacyReleaseConfigs)
      .set({ inactivityWarningSentAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.legacyReleaseConfigs.id, configId));
    await this.recordAudit("system", "legacy-release-inactivity-monitor", "legacy_release.inactivity_warning_sent", configId);
  }

  // --- Public, unauthenticated redemption ---------------------------------------------------------------

  /**
   * Mirrors SharingService.resolveShareLink/CaregiverDayPassService.access's own timing/error-message
   * discipline (an unknown token must be indistinguishable from any other invalid state).
   */
  async access(token: string) {
    const releaseTokenHash = createHash("sha256").update(token).digest("hex");
    const [config] = await this.db.select().from(schema.legacyReleaseConfigs).where(eq(schema.legacyReleaseConfigs.releaseTokenHash, releaseTokenHash)).limit(1);
    if (!config || config.status !== "released") {
      throw new NotFoundException({ code: "LEGACY_RELEASE_NOT_FOUND", message: "This link is invalid." });
    }
    await this.sharing.recordAnonymousAccess("legacy_release", config.id);
    return this.buildPacket(config.ownerUserId, config.householdId, config.categories as LegacyReleaseCategory[]);
  }

  /** Same category set EmergencyBinderService.getBinder aggregates, filtered to only what the owner
   * selected — see this class's own doc comment for why it reuses that shape rather than per-resource
   * grants. Never includes a raw identity-record document number (identityRecordSafeColumns), same as the
   * binder itself. */
  private async buildPacket(ownerUserId: string, householdId: string | null, categories: LegacyReleaseCategory[]) {
    const packet: Record<string, unknown> = {};

    if (categories.includes("household_roster") && householdId) {
      packet.householdRoster = await this.db
        .select({ displayName: schema.users.displayName, relationshipLabel: schema.householdMemberships.relationshipLabel, role: schema.householdMemberships.role })
        .from(schema.householdMemberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.householdMemberships.userId))
        .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.status, "active")));
    }
    if (categories.includes("vehicles") && householdId) {
      packet.vehicles = await this.db
        .select({ label: schema.vehicleProfiles.label, make: schema.vehicleProfiles.make, model: schema.vehicleProfiles.model, year: schema.vehicleProfiles.year })
        .from(schema.vehicleProfiles)
        .where(and(eq(schema.vehicleProfiles.householdId, householdId), isNull(schema.vehicleProfiles.deletedAt)));
    }
    if (categories.includes("properties") && householdId) {
      packet.properties = await this.db
        .select({ label: schema.propertyProfiles.label, propertyType: schema.propertyProfiles.propertyType, address: schema.propertyProfiles.address })
        .from(schema.propertyProfiles)
        .where(and(eq(schema.propertyProfiles.householdId, householdId), isNull(schema.propertyProfiles.deletedAt)));
    }
    if (categories.includes("pets") && householdId) {
      packet.pets = await this.db
        .select({ label: schema.petProfiles.label, species: schema.petProfiles.species, breed: schema.petProfiles.breed })
        .from(schema.petProfiles)
        .where(and(eq(schema.petProfiles.householdId, householdId), isNull(schema.petProfiles.deletedAt)));
    }
    if (categories.includes("identity_records")) {
      const rows = await this.db
        .select({ recordType: schema.identityRecords.recordType, label: schema.identityRecords.label, issuingAuthority: schema.identityRecords.issuingAuthority, expirationDate: schema.identityRecords.expirationDate })
        .from(schema.identityRecords)
        .where(and(eq(schema.identityRecords.ownerUserId, ownerUserId), ne(schema.identityRecords.status, "renewed"), isNull(schema.identityRecords.deletedAt)));
      packet.identityRecords = rows;
    }
    if (categories.includes("documents") && householdId) {
      packet.documents = await this.db
        .select({ title: schema.documents.title, documentType: schema.documents.documentType })
        .from(schema.documents)
        .where(and(eq(schema.documents.householdId, householdId), eq(schema.documents.isEmergencyBinderItem, true), ne(schema.documents.visibility, "private"), isNull(schema.documents.deletedAt)));
    }
    if ((categories.includes("medications_notes") || categories.includes("emergency_instructions")) && householdId) {
      const [household] = await this.db.select({ medicationsNotes: schema.households.medicationsNotes, emergencyInstructions: schema.households.emergencyInstructions }).from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
      if (categories.includes("medications_notes")) packet.medicationsNotes = household?.medicationsNotes ?? null;
      if (categories.includes("emergency_instructions")) packet.emergencyInstructions = household?.emergencyInstructions ?? null;
    }
    return packet;
  }
}
