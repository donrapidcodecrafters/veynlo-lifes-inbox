import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId, CATEGORY_DOMAIN_KEYS, CATEGORY_DOMAIN_COPY, type CategoryDomainKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { IdentityService } from "../identity/identity.service";
import type { UpdateHomeModulePreferencesDto, UpdateCategoryPreferenceDto, UpdatePersonalizationPreferencesDto } from "./dto";

const OPTIONAL_HOME_MODULE_KEYS = ["today", "money_at_risk", "family_today"] as const;

/** Belt-and-suspenders filter applied on top of the DTO's own enum validation — even if a bad value
 * somehow reached this far (e.g. a stale stored row from before a module key was renamed/removed), "needs_you"
 * specifically can never survive into a stored preference. PERS-002 is explicit that Needs You "remains
 * accessible" regardless of what a user configures. */
function sanitizeModuleKeys(keys: string[] | undefined): string[] | undefined {
  if (!keys) return undefined;
  return keys.filter((k): k is (typeof OPTIONAL_HOME_MODULE_KEYS)[number] => (OPTIONAL_HOME_MODULE_KEYS as readonly string[]).includes(k) && k !== "needs_you");
}

@Injectable()
export class PreferencesService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  // ---- PERS-002 Home customization ----------------------------------------------------------------

  async getHomeModulePreferences(userId: string) {
    const [row] = await this.db.select().from(schema.homeModulePreferences).where(eq(schema.homeModulePreferences.userId, userId)).limit(1);
    return row ?? { userId, moduleOrder: [] as string[], hiddenModules: [] as string[] };
  }

  async updateHomeModulePreferences(userId: string, patch: UpdateHomeModulePreferencesDto) {
    const existing = await this.getHomeModulePreferences(userId);
    const moduleOrder = sanitizeModuleKeys(patch.moduleOrder) ?? existing.moduleOrder;
    const hiddenModules = sanitizeModuleKeys(patch.hiddenModules) ?? existing.hiddenModules;
    const merged = { userId, moduleOrder, hiddenModules, updatedAt: new Date() };
    await this.db.insert(schema.homeModulePreferences).values(merged).onConflictDoUpdate({ target: schema.homeModulePreferences.userId, set: merged });
    return merged;
  }

  // ---- PERS-003 Category preferences --------------------------------------------------------------

  /** Every known category, defaulting to enabled — a domain with no stored row has never been opted out. */
  async listCategoryPreferences(userId: string) {
    const rows = await this.db.select().from(schema.categoryPreferences).where(eq(schema.categoryPreferences.userId, userId));
    const byDomain = new Map(rows.map((r) => [r.domain, r]));
    return CATEGORY_DOMAIN_KEYS.map((domain) => ({
      domain,
      label: CATEGORY_DOMAIN_COPY[domain].label,
      disableExplanation: CATEGORY_DOMAIN_COPY[domain].disableExplanation,
      enabled: byDomain.get(domain)?.enabled ?? true,
    }));
  }

  async updateCategoryPreference(userId: string, dto: UpdateCategoryPreferenceDto) {
    const [existing] = await this.db
      .select({ id: schema.categoryPreferences.id })
      .from(schema.categoryPreferences)
      .where(and(eq(schema.categoryPreferences.userId, userId), eq(schema.categoryPreferences.domain, dto.domain)))
      .limit(1);
    if (existing) {
      await this.db.update(schema.categoryPreferences).set({ enabled: dto.enabled, updatedAt: new Date() }).where(eq(schema.categoryPreferences.id, existing.id));
    } else {
      await this.db.insert(schema.categoryPreferences).values({
        id: generateId("categoryPreference"),
        userId,
        domain: dto.domain,
        enabled: dto.enabled,
      });
    }
    return { domain: dto.domain, enabled: dto.enabled, label: CATEGORY_DOMAIN_COPY[dto.domain].label, disableExplanation: CATEGORY_DOMAIN_COPY[dto.domain].disableExplanation };
  }

  /**
   * The actual enforcement read — called by IngestionService.classifyAndExtract before routing to a
   * gated domain extractor, mirroring EntitlementsService.getCapability's role for plan gates exactly
   * (same "no row = most permissive default" posture: an entitlement with no matching row resolves to
   * the free plan's value; a category preference with no row resolves to enabled).
   */
  async isCategoryEnabled(userId: string, domain: CategoryDomainKey): Promise<boolean> {
    const [row] = await this.db
      .select({ enabled: schema.categoryPreferences.enabled })
      .from(schema.categoryPreferences)
      .where(and(eq(schema.categoryPreferences.userId, userId), eq(schema.categoryPreferences.domain, domain)))
      .limit(1);
    return row?.enabled ?? true;
  }

  // ---- PERS-004/PERS-005 Personalization -----------------------------------------------------------

  async getPersonalizationPreferences(userId: string) {
    const [row] = await this.db.select().from(schema.personalizationPreferences).where(eq(schema.personalizationPreferences.userId, userId)).limit(1);
    return (
      row ?? {
        userId,
        preferredName: null as string | null,
        weekStart: "sunday" as const,
        timeFormat: "12h" as const,
        askResponseStyle: "balanced" as const,
        suggestionIntensity: "balanced" as const,
        financialPrivacyModeEnabled: false,
      }
    );
  }

  async updatePersonalizationPreferences(userId: string, patch: UpdatePersonalizationPreferencesDto) {
    const existing = await this.getPersonalizationPreferences(userId);
    const merged = { ...existing, ...patch, userId, updatedAt: new Date() };
    await this.db.insert(schema.personalizationPreferences).values(merged).onConflictDoUpdate({ target: schema.personalizationPreferences.userId, set: merged });
    return merged;
  }

  /** PERS-005 — used by SearchService.ask to pick the style-instruction addendum; never used to alter
   * anything about the injection-defense system prompt or evidence-grounding logic (see ask's own doc
   * comment). Falls back to "balanced" the same way getPersonalizationPreferences does. */
  async getAskResponseStyle(userId: string): Promise<"concise" | "balanced" | "detailed"> {
    const [row] = await this.db.select({ askResponseStyle: schema.personalizationPreferences.askResponseStyle }).from(schema.personalizationPreferences).where(eq(schema.personalizationPreferences.userId, userId)).limit(1);
    return (row?.askResponseStyle as "concise" | "balanced" | "detailed") ?? "balanced";
  }

  // ---- FIN-007 Financial privacy mode ---------------------------------------------------------------

  /** The actual enforcement read — used by NotificationDispatchService/WidgetsService (and the web/mobile
   * clients themselves) to decide whether to mask a dollar amount/account name. No row = disabled, the
   * same "no row = most permissive default" posture `isCategoryEnabled` above already uses. */
  async isFinancialPrivacyModeEnabled(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ financialPrivacyModeEnabled: schema.personalizationPreferences.financialPrivacyModeEnabled })
      .from(schema.personalizationPreferences)
      .where(eq(schema.personalizationPreferences.userId, userId))
      .limit(1);
    return row?.financialPrivacyModeEnabled ?? false;
  }

  /**
   * FIN-007 "biometric reveal option" — web's step-up counterpart to mobile's on-device biometric unlock
   * (apps/mobile's BiometricLockContext.unlock never touches the server at all — see that file's own doc
   * comment). Mirrors IdentityRecordsService.revealDocumentNumber's exact ordering/audit discipline: same
   * PASSWORD_REQUIRED/INVALID_CREDENTIALS error shape, same "every outcome writes an audit_events row"
   * rule. Not gated on any specific resource (masking applies to a whole session/view, not one record), so
   * there's no ownership check to run first. Deliberately never persists a "revealed" flag anywhere server
   * side — the reveal is a client-side, in-memory-only state for the current screen; a fresh load always
   * starts masked again, matching the spec's "mask by default" line.
   */
  async revealFinancialPrivacy(userId: string, password: string | undefined): Promise<{ revealed: true }> {
    try {
      await this.identity.verifyStepUpPassword(userId, password);
    } catch (err) {
      await this.recordFinancialPrivacyRevealEvent(userId, password ? "failure" : "denied");
      throw err;
    }
    await this.recordFinancialPrivacyRevealEvent(userId, "success");
    return { revealed: true };
  }

  private async recordFinancialPrivacyRevealEvent(userId: string, result: "success" | "failure" | "denied"): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: userId,
      action: "financial_privacy.reveal",
      resourceType: "user",
      resourceId: userId,
      result,
    });
  }
}
