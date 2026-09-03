import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, or, sum } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import type { CreateShareLinkDto, ResourceGrantRight } from "../sharing/dto";
import type {
  CreateStoreCreditDto,
  CreateSubscriptionDto,
  LinkWarrantyToAssetDto,
  UpdatePurchaseLineDto,
  SetMerchantPriceAdjustmentPolicyDto,
  SetMerchantCancellationStepsDto,
  MarkReturnLabelReadyDto,
  CloseReturnDto,
} from "./dto";
import { resolvePriceAdjustmentPolicy, setUserPriceAdjustmentPolicy, priceAdjustmentDeadline, daysUntil } from "./price-adjustment-policy";
import { resolveMerchantCancellationSteps, setUserMerchantCancellationSteps } from "./merchant-cancellation-steps";
import { billerCategoryLabel } from "./biller-category";
import { merchantSupportsPause, PAUSE_CAPABLE_MERCHANT_NAMES } from "./pause-capability";
import { SearchIndexService } from "../search/search-index.service";
// §40.3 subscription/return timers — the same "N days before, computed in application code since this
// date has no dedicated sort column" pattern AttentionService.scanAndFileDeadlines already uses for
// subscriptions.trialEndsAt, reused here for recurringStreams.nextExpectedDate (also sort-column-less).
// Importing a pure read-only utility from another module's file, same as this file already does for
// HouseholdService/SharingService — not an edit to ingestion.service.ts itself.
import { temporalToSortDate } from "../ingestion/temporal.util";

// UTIL-001 "Shows current bill vs prior/seasonal baseline" — how far above the average of a biller's own
// prior bills the current one has to be before it's called out as notably high, rather than ordinary
// month-to-month variation (a winter electric bill running higher than a mild-spring one isn't itself
// noteworthy). 25% is a deliberately simple, documented threshold — not tuned against real utility-pricing
// data (this codebase has none), but well above the kind of variance a normal seasonal swing alone would
// be expected to produce for most of the tracked utility categories.
const BILL_BASELINE_SIGNIFICANT_THRESHOLD = 0.25;
// "average of the same biller's PRIOR bills (last 12 months, or fewer if less history exists)" — most
// utility bills are monthly, so this doubles as "up to the last 12 monthly bills."
const BILL_BASELINE_MAX_SAMPLE = 12;
// Below this many prior bills, an "average" is too noisy to call anything a meaningful baseline — one
// single prior bill isn't a baseline, it's just the last bill.
const BILL_BASELINE_MIN_SAMPLE = 2;

// §40.3 "Representative state machines" — Purchase: candidate → confirmed → fulfilled/partially fulfilled
// → kept / return started / gifted / sold / disposed. These are the ORDER-level terminal outcomes; a
// purchase's individual lines can independently carry their own giftFlag/resaleStatus per this row's own
// guardrail ("Line item can differ from order state") — see recomputePurchaseOutcomeState below.
// A purchase auto-confirms once its own extraction confidence is solid enough — the spec's Inbox-row
// guardrail ("auto-resolve only for low-risk high-confidence categories") applied to the one signal this
// codebase already tracks per purchase row: `purchases.confidenceBand`, decided once at extraction time by
// IngestionService.extractReceipt — no separate re-scoring needed.
const PURCHASE_AUTO_CONFIRM_BANDS = ["verified", "high"];

// §40.3 Return state machine — eligible → initiated → label/dropoff ready → in transit → merchant received
// → refund expected → refunded / exchanged / disputed / closed. "resolved" is kept alongside the new named
// terminal states for backward compatibility: PlaidAdapter.matchTransaction (services/api/src/modules/
// connectors/plaid.adapter.ts — outside this module's ownership this round) still writes exactly that
// state when a refund transaction is auto-matched, and the pre-existing `resolveReturn` manual-completion
// method below is left behaviorally unchanged rather than broken for its existing callers.
const RETURN_TERMINAL_STATES = ["resolved", "refunded", "exchanged", "disputed", "closed"];
// Financially-successful terminal outcomes only, for savingsSummary's "money actually saved" aggregate —
// "disputed" (still unresolved) and "closed" (given up with no refund) are deliberately excluded.
const RETURN_SAVINGS_STATES = ["resolved", "refunded", "exchanged"];

// §40.3 Subscription state machine — candidate → trial/active → renewal upcoming / price changed / paused
// → cancellation pending → canceled/expired. A subscription is "currently paying" (eligible to enter
// renewal_upcoming, or to have a cancellation submitted against it) in any of these states.
const SUBSCRIPTION_ACTIVE_LIKE_STATES = ["active", "trial_ended", "price_changed", "renewal_upcoming"];
// "N days before" reminder-window pattern, same shape as AttentionService's own LOOKAHEAD_MS (14 days) —
// a renewal is a much smaller, routine decision than a trial converting to paid for the first time
// (trial_ending's own 14-day window), so a shorter week-out heads-up is enough to act on.
const SUBSCRIPTION_RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class CommerceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional
    // `new CommerceService(...)` test construction keeps compiling unchanged.
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  /**
   * FAM-006 enforcement — a caregiver delegated "commerce:read" on a household sees that household's
   * purchases/bills/returns/subscriptions/warranties alongside their own, not just their own. Returns a
   * Drizzle condition ORing the caller's own rows with any row belonging to a household they've been
   * delegated commerce:read on; the household branch is omitted entirely when there are none, since
   * `inArray` with an empty array is invalid SQL.
   *
   * Also OR's in plain active membership (see HouseholdService.activeHouseholdIds's own doc comment) —
   * delegation alone meant an ordinary household member (not a delegated caregiver) never saw a shared
   * household purchase/bill/subscription/warranty/store credit that someone else in the household added,
   * confirmed live on the Life screen.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "commerce:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  async purchases(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("purchase", userId);
    const baseCondition = await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId);
    const accessCondition = grantedIds.length > 0 ? or(baseCondition, inArray(schema.purchases.id, grantedIds))! : baseCondition;
    return this.db.select().from(schema.purchases).where(accessCondition);
  }

  async purchaseDetail(purchaseId: string, userId: string) {
    const [purchase] = await this.db
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchaseId))
      .limit(1);
    if (!purchase) return null;
    // Phase 2 §52.2 "object sharing" — a direct resourceGrant on this specific purchase is an access
    // path in its own right, alongside ownership/household visibility, same as assertCommerceAccess
    // (used by every OTHER commerce detail method below) — folded in here too via that same helper.
    if (!(await this.assertCommerceAccess(purchase.ownerUserId, purchase.householdId, userId, { resourceType: "purchase", resourceId: purchaseId }))) return null;
    // SHARE-001 "optional message" — see ListsService.listDetail's identical reasoning for why this is
    // null for owner/household access and only ever populated for a grant-based visitor.
    const sharedNote = (await this.isOwnerOrHouseholdCommerce(purchase.ownerUserId, purchase.householdId, userId))
      ? null
      : await this.sharing.grantMessage("purchase", purchaseId, userId);
    const lines = await this.db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
    const returns = await this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId));
    const shipments = await this.db.select().from(schema.shipments).where(eq(schema.shipments.purchaseId, purchaseId));
    const evidence = await this.evidenceForSourceEvent(purchase.sourceEventId);
    const merchantName = purchase.merchantId ? await this.merchantDisplayName(purchase.merchantId) : null;
    // RET-004 "Price-adjustment opportunity" — mirrors subscriptionDetail's priceHistory read-back:
    // IngestionService.extractReceipt writes a price_observations row (subjectEntityId = the purchase
    // line's own id, since that's "the thing this observation is about" — see its doc comment) whenever a
    // later purchase of the exact same product comes in cheaper within the 30-day window heuristic. Read
    // back here, keyed by this purchase's own line ids, so the purchase detail page can show a badge/banner
    // without a new column or state field on purchase_lines.
    const lineIds = lines.map((l) => l.id);
    const priceAdjustments =
      lineIds.length > 0
        ? await this.db
            .select({
              purchaseLineId: schema.priceObservations.subjectEntityId,
              observedAmountMinorUnits: schema.priceObservations.observedAmountMinorUnits,
              observedAmountCurrency: schema.priceObservations.observedAmountCurrency,
              observedAt: schema.priceObservations.observedAt,
            })
            .from(schema.priceObservations)
            .where(inArray(schema.priceObservations.subjectEntityId, lineIds))
            .orderBy(desc(schema.priceObservations.observedAt))
        : [];
    // RET-004 "Policy engine ... deadline calculator" — only meaningful once there's an actual detected
    // price-adjustment opportunity to show a deadline/confidence for (see fields the banner reads: an
    // untouched purchase with no priceAdjustments has nothing to count down to). Deadline is always
    // computed from THIS purchase's own purchaseDateSort/merchantId — it's the ORIGINAL, higher-priced
    // purchase, since priceAdjustments' subjectEntityId points at one of `lines`, which all belong to this
    // same purchase (see extractReceipt/findMostRecentPriorPurchaseLine's own doc comments).
    const priceAdjustmentPolicy =
      priceAdjustments.length > 0 && purchase.purchaseDateSort
        ? await (async () => {
            const policy = await resolvePriceAdjustmentPolicy(this.db, purchase.merchantId, userId);
            const deadline = priceAdjustmentDeadline(purchase.purchaseDateSort!, policy.windowDays);
            return {
              windowDays: policy.windowDays,
              confidence: policy.confidence,
              sourceNote: policy.sourceNote,
              isDefault: policy.policyId === null,
              deadline: deadline.toISOString(),
              daysLeft: daysUntil(deadline),
            };
          })()
        : null;
    return { purchase, merchantName, lines, returns, shipments, evidence, priceAdjustments, priceAdjustmentPolicy, sharedNote };
  }

  /**
   * RET-004 policy management — the resolved policy for one merchant, from this caller's point of view
   * (their own "user_confirmed" correction if they have one, else the global seeded fact, else the flat
   * default — see resolvePriceAdjustmentPolicy's own doc comment for the precedence rule). Used by the
   * purchase-detail page's inline policy editor to show the current value before a user changes it, and
   * works for ANY merchant a caller can name — not gated to merchants they've actually purchased from,
   * since this table is global reference data, not owner-scoped.
   */
  async merchantPriceAdjustmentPolicy(merchantId: string, userId: string) {
    return resolvePriceAdjustmentPolicy(this.db, merchantId, userId);
  }

  /**
   * RET-004 "let a user manually add/correct a policy for a merchant they know the real terms for" — the
   * one write path onto merchant_price_adjustment_policies a non-admin user has. Always writes
   * confidence "user_confirmed", scoped to this caller only (see the table's own doc comment on why this
   * is deliberately never a global overwrite) via setUserPriceAdjustmentPolicy.
   */
  async setMerchantPriceAdjustmentPolicy(merchantId: string, userId: string, dto: SetMerchantPriceAdjustmentPolicyDto): Promise<void> {
    const [merchant] = await this.db.select({ id: schema.merchants.id }).from(schema.merchants).where(eq(schema.merchants.id, merchantId)).limit(1);
    if (!merchant) throw new NotFoundException({ code: "MERCHANT_NOT_FOUND", message: "That merchant doesn't exist." });
    await setUserPriceAdjustmentPolicy(this.db, merchantId, userId, { windowDays: dto.windowDays, sourceNote: dto.sourceNote });
  }

  private async merchantDisplayName(merchantId: string): Promise<string | null> {
    const [row] = await this.db.select({ displayName: schema.merchants.displayName }).from(schema.merchants).where(eq(schema.merchants.id, merchantId)).limit(1);
    return row?.displayName ?? null;
  }

  /**
   * §39.2/Absolute Product Rule "Evidence before assertion" — "why am I seeing this?" needs at least
   * enough of the original source to recognize it. `source_events` deliberately never stores the full
   * body (see its schema comment), only what was captured at ingest time: subject/snippet/sender and
   * which connection it came from. Returns null when there's genuinely nothing to show (no sourceEventId
   * at all, e.g. seed data or a domain nothing currently traces back to a source) rather than a fake
   * placeholder.
   */
  private async evidenceForSourceEvent(sourceEventId: string | null) {
    if (!sourceEventId) return null;
    const [row] = await this.db
      .select({ event: schema.sourceEvents, connection: schema.connections })
      .from(schema.sourceEvents)
      .leftJoin(schema.connections, eq(schema.connections.id, schema.sourceEvents.connectionId))
      .where(eq(schema.sourceEvents.id, sourceEventId))
      .limit(1);
    if (!row) return null;
    return {
      sourceEventId: row.event.id,
      kind: row.event.kind,
      subjectLine: row.event.subjectLine,
      snippet: row.event.snippet,
      fromAddress: row.event.fromAddress,
      occurredAt: row.event.occurredAt,
      provider: row.connection?.provider ?? null,
    };
  }

  /** Bills/warranties have no direct sourceEventId column — traced indirectly via the inbox_items row that filed them (every successful extraction files one; see IngestionService.fileInboxItem). */
  private async evidenceViaInboxItem(linkedResourceType: string, linkedResourceId: string) {
    const [inboxItem] = await this.db
      .select({ sourceEventId: schema.inboxItems.sourceEventId })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.linkedResourceType, linkedResourceType), eq(schema.inboxItems.linkedResourceId, linkedResourceId)))
      .limit(1);
    return this.evidenceForSourceEvent(inboxItem?.sourceEventId ?? null);
  }

  /**
   * `grant`, when passed, additionally honors a direct resourceGrant on that specific resource — see
   * SharingService's own doc comment. Optional (rather than required) because only purchases have a
   * sharing endpoint today; bills/warranties/returns/subscriptions/store credits still only check
   * ownership/household, unchanged from before.
   *
   * SHARE-001 enforcement — `requiredRight` (default "view", the only thing that ever mattered before this
   * pass) lets a WRITE call site demand a stronger grant than a read does: `purchaseDetail` still only
   * needs "view" (any active grant), but `updatePurchaseLine` now passes "edit" so a view-only grantee
   * can't reach this true at all.
   */
  private async assertCommerceAccess(
    ownerUserId: string,
    householdId: string | null,
    userId: string,
    grant?: { resourceType: string; resourceId: string },
    requiredRight: ResourceGrantRight = "view",
  ): Promise<boolean> {
    if (ownerUserId === userId) return true;
    if (householdId) {
      const [delegatedIds, memberIds] = await Promise.all([
        this.households.delegatedHouseholdIds(userId, "commerce:read"),
        this.households.activeHouseholdIds(userId),
      ]);
      if (delegatedIds.includes(householdId) || memberIds.includes(householdId)) return true;
    }
    if (grant && (await this.sharing.hasGrantAtLeast(grant.resourceType, grant.resourceId, userId, requiredRight))) {
      // §35 SHARE-007 "access_audit" — same reasoning as PetsService.assertPetAccess/AssetsService.
      // assertAssetAccess/PeopleService.assertAccess: this gate calls hasGrantAtLeast directly, so it
      // can't rely on SharingService.hasActiveGrant's own built-in logging.
      await this.sharing.recordGrantAccess(grant.resourceType, grant.resourceId, userId);
      return true;
    }
    return false;
  }

  /** Plain ownership-or-household check with no grant involved — used only to decide whether a grant
   * message is even worth looking up (owner/household access never has one). */
  private async isOwnerOrHouseholdCommerce(ownerUserId: string, householdId: string | null, userId: string): Promise<boolean> {
    return this.assertCommerceAccess(ownerUserId, householdId, userId);
  }

  async billDetail(billId: string, userId: string) {
    const [bill] = await this.db.select().from(schema.bills).where(eq(schema.bills.id, billId)).limit(1);
    if (!bill || !(await this.assertCommerceAccess(bill.ownerUserId, bill.householdId, userId))) return null;
    return { bill, evidence: await this.evidenceViaInboxItem("bill", billId), baselineComparison: await this.computeBillBaseline(bill) };
  }

  /**
   * UTIL-001 "Shows current bill vs prior/seasonal baseline" — the one specific gap in an otherwise
   * generic bills pipeline (bills/recurringStreams already capture any recurring biller, utility or not;
   * see biller-category.ts's own doc comment on why categorization is heuristic-only). Public wrapper doing
   * its own access check, mirroring every other `xDetail` method's shape, so it can also be called directly
   * (e.g. from a future notifications job) without going through the full `billDetail` payload.
   */
  async billBaselineComparison(billId: string, userId: string) {
    const [bill] = await this.db.select().from(schema.bills).where(eq(schema.bills.id, billId)).limit(1);
    if (!bill || !(await this.assertCommerceAccess(bill.ownerUserId, bill.householdId, userId))) return null;
    return this.computeBillBaseline(bill);
  }

  /**
   * Same "encrypted column, so match in application code" stance as findExistingBill's own doc comment —
   * billerLabel can't be compared via SQL equality, so this fetches this owner's other bills and normalizes
   * both sides after Drizzle's encryptedText customType transparently decrypts them on select. Scoped to
   * bills sharing the same normalized billerLabel AND currency (mixing currencies into one average would
   * silently misstate it, same "under-reporting is honest, mixing is not" stance as savingsSummary's own
   * currency guard) — deliberately NOT scoped to billerCategory, since two genuinely different billers can
   * share a category (two different mobile carriers) while a single real biller's bills should still all
   * compare against each other even if categorizeBiller couldn't classify the name at all.
   */
  private async computeBillBaseline(bill: typeof schema.bills.$inferSelect) {
    if (bill.amountDueMinorUnits == null || !bill.amountDueCurrency) return null;
    const normalize = (s: string) => s.trim().toLowerCase();
    const targetLabel = normalize(bill.billerLabel);
    const ownersBills = await this.db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, bill.ownerUserId));
    const priorBills = ownersBills
      .filter(
        (b) =>
          b.id !== bill.id &&
          normalize(b.billerLabel) === targetLabel &&
          b.amountDueMinorUnits != null &&
          b.amountDueCurrency === bill.amountDueCurrency &&
          b.dueDateSort != null,
      )
      .sort((a, b) => b.dueDateSort!.getTime() - a.dueDateSort!.getTime())
      .slice(0, BILL_BASELINE_MAX_SAMPLE);
    if (priorBills.length < BILL_BASELINE_MIN_SAMPLE) return null;

    const averageMinorUnits = Math.round(priorBills.reduce((sum, b) => sum + b.amountDueMinorUnits!, 0) / priorBills.length);
    const diffMinorUnits = bill.amountDueMinorUnits - averageMinorUnits;
    const percentAboveBaseline = averageMinorUnits > 0 ? diffMinorUnits / averageMinorUnits : 0;
    const isSignificantlyAboveBaseline = percentAboveBaseline > BILL_BASELINE_SIGNIFICANT_THRESHOLD;

    return {
      billerCategory: bill.billerCategory,
      billerCategoryLabel: billerCategoryLabel(bill.billerCategory),
      sampleSize: priorBills.length,
      currentMinorUnits: bill.amountDueMinorUnits,
      averageMinorUnits,
      diffMinorUnits,
      currency: bill.amountDueCurrency,
      percentAboveBaseline: Math.round(percentAboveBaseline * 1000) / 1000,
      isSignificantlyAboveBaseline,
      isBelowBaseline: diffMinorUnits < 0,
    };
  }

  async warrantyDetail(warrantyId: string, userId: string) {
    const [warranty] = await this.db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId)).limit(1);
    if (!warranty || !(await this.assertCommerceAccess(warranty.ownerUserId, warranty.householdId, userId))) return null;
    return { warranty, evidence: await this.evidenceViaInboxItem("warranty", warrantyId) };
  }

  /** propertyProfiles/vehicleProfiles owned by (or household-shared with) `warrantyOwnerUserId`/`warrantyHouseholdId` — the same access model warranties themselves use, so a warranty can only ever be linked to an asset its own owner/household could already see. Throws NOT_FOUND rather than silently no-op'ing, since a bad id here is a real client bug, not a benign race. */
  private async assertLinkableProfile(table: typeof schema.propertyProfiles | typeof schema.vehicleProfiles, id: string, warrantyOwnerUserId: string, warrantyHouseholdId: string | null, notFoundCode: string): Promise<void> {
    const [row] = await this.db.select({ ownerUserId: table.ownerUserId, householdId: table.householdId }).from(table).where(eq(table.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: notFoundCode, message: "Not found." });
    const sameOwner = row.ownerUserId === warrantyOwnerUserId;
    const sameHousehold = row.householdId != null && row.householdId === warrantyHouseholdId;
    if (!sameOwner && !sameHousehold) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
  }

  /** homeAssets has no `householdId` column of its own (see its schema doc comment — it's always tied to
   * exactly one propertyProfile via a NOT NULL FK, unlike propertyProfiles/vehicleProfiles which carry
   * their own direct household link), so this checks direct ownership only rather than
   * assertLinkableProfile's owner-or-household check above. */
  private async assertLinkableHomeAsset(id: string, warrantyOwnerUserId: string): Promise<void> {
    const [row] = await this.db.select({ ownerUserId: schema.homeAssets.ownerUserId }).from(schema.homeAssets).where(eq(schema.homeAssets.id, id)).limit(1);
    if (!row) throw new NotFoundException({ code: "HOME_ASSET_NOT_FOUND", message: "Not found." });
    if (row.ownerUserId !== warrantyOwnerUserId) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
  }

  /**
   * Phase 2 §52.2 "service/warranty/maintenance history" — the missing write path for
   * `warranties.propertyProfileId`/`.vehicleProfileId`/`.homeAssetId`; mirrors
   * HealthLogisticsService.linkBillToAppointment's shape (verify ownership of both sides, then a plain
   * column update) for a consistent style across the app's "link one thing to another" endpoints.
   *
   * Each field is a genuine partial patch: omitted from the body → untouched; explicit `null` → cleared;
   * a string → set (after verifying that id is a real, accessible row). Re-derives the row's final
   * propertyProfileId/vehicleProfileId (this request's patch applied on top of whatever was already
   * stored) and rejects if that would leave both non-null — the DTO's own refine only catches both being
   * set in the SAME request; this also catches setting one when the other was already set from an earlier
   * call.
   */
  async linkWarrantyToAsset(warrantyId: string, userId: string, dto: LinkWarrantyToAssetDto): Promise<void> {
    const [warranty] = await this.db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId)).limit(1);
    if (!warranty) throw new NotFoundException({ code: "WARRANTY_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(warranty.ownerUserId, warranty.householdId, userId))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }

    const nextPropertyProfileId = "propertyProfileId" in dto ? dto.propertyProfileId! : warranty.propertyProfileId;
    const nextVehicleProfileId = "vehicleProfileId" in dto ? dto.vehicleProfileId! : warranty.vehicleProfileId;
    if (nextPropertyProfileId && nextVehicleProfileId) {
      throw new BadRequestException({ code: "CONFLICTING_ASSET_LINK", message: "A warranty can be linked to a property or a vehicle, never both — clear the other link first." });
    }

    if (dto.propertyProfileId) await this.assertLinkableProfile(schema.propertyProfiles, dto.propertyProfileId, warranty.ownerUserId, warranty.householdId, "PROPERTY_NOT_FOUND");
    if (dto.vehicleProfileId) await this.assertLinkableProfile(schema.vehicleProfiles, dto.vehicleProfileId, warranty.ownerUserId, warranty.householdId, "VEHICLE_NOT_FOUND");
    if (dto.homeAssetId) await this.assertLinkableHomeAsset(dto.homeAssetId, warranty.ownerUserId);

    const patch: Partial<typeof schema.warranties.$inferInsert> = { updatedAt: new Date() };
    if ("propertyProfileId" in dto) patch.propertyProfileId = dto.propertyProfileId ?? null;
    if ("vehicleProfileId" in dto) patch.vehicleProfileId = dto.vehicleProfileId ?? null;
    if ("homeAssetId" in dto) patch.homeAssetId = dto.homeAssetId ?? null;
    await this.db.update(schema.warranties).set(patch).where(eq(schema.warranties.id, warrantyId));
  }

  async returnDetail(returnCaseId: string, userId: string) {
    const [row] = await this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(eq(schema.returnCases.id, returnCaseId))
      .limit(1);
    if (!row || !(await this.assertCommerceAccess(row.purchase.ownerUserId, row.purchase.householdId, userId))) return null;
    // No direct evidence trail of its own — a return case is created inside extractReceipt from the same
    // email as its parent purchase, so the parent's source event IS the evidence for the return too.
    return { returnCase: row.returnCase, purchase: row.purchase, evidence: await this.evidenceForSourceEvent(row.purchase.sourceEventId) };
  }

  async subscriptionDetail(subscriptionId: string, userId: string) {
    const [row] = await this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(eq(schema.subscriptions.id, subscriptionId))
      .limit(1);
    if (!row || !(await this.assertCommerceAccess(row.stream.ownerUserId, row.stream.householdId, userId))) return null;
    // SUB-001 "Shows ... price history" — found live while auditing §18: extractSubscription's
    // price-change branch (see ingestion.service.ts) already logs every detected change to
    // price_observations, but nothing downstream ever read the table back — a subscription's price
    // history was captured and then permanently invisible.
    const priceHistory = await this.db
      .select({
        observedAmountMinorUnits: schema.priceObservations.observedAmountMinorUnits,
        observedAmountCurrency: schema.priceObservations.observedAmountCurrency,
        observedAt: schema.priceObservations.observedAt,
      })
      .from(schema.priceObservations)
      .where(eq(schema.priceObservations.subjectEntityId, row.stream.id))
      .orderBy(asc(schema.priceObservations.observedAt));
    // SUB-004 "shows known steps ... when a direct API/partner flow doesn't exist" — only meaningful as a
    // fallback: the UI shows subscription.cancellationInstructionsUrl (an evidenced, first-party fact from
    // the source email) first, and only falls back to these curated steps when no such URL was ever
    // evidenced. Null when the stream has no resolved merchant, or nothing is curated for it yet — the UI
    // keeps its existing honest "not found" message in that case, same as it always has.
    const cancellationSteps = row.stream.merchantId ? await resolveMerchantCancellationSteps(this.db, row.stream.merchantId, userId) : null;
    // §40.3 "Pause" UI gap — pauseSubscription rejects every subscription today (see pause-capability.ts's
    // own doc comment: PAUSE_CAPABLE_MERCHANT_NAMES is a real, currently-empty allowlist), but the client
    // has no way to know that ahead of a failed POST. Rather than the UI showing a "Pause" button that
    // always 400s, this resolves the same merchantSupportsPause check server-side so the detail page can
    // honestly hide the button until a real merchant is ever added to that allowlist.
    const merchantName = row.stream.merchantId ? await this.merchantDisplayName(row.stream.merchantId) : null;
    return {
      subscription: row.subscription,
      stream: row.stream,
      merchantName,
      canPause: merchantSupportsPause(merchantName),
      priceHistory,
      cancellationSteps,
      evidence: await this.evidenceViaInboxItem("subscription", subscriptionId),
    };
  }

  /**
   * SUB-004 "shows known steps" — resolved curated (or user-corrected) cancellation steps for one
   * merchant, from this caller's point of view. Mirrors merchantPriceAdjustmentPolicy's own shape/doc
   * comment exactly: works for any merchant a caller can name, not gated to merchants they've actually
   * subscribed to, since this table is global reference data.
   */
  async merchantCancellationSteps(merchantId: string, userId: string) {
    return resolveMerchantCancellationSteps(this.db, merchantId, userId);
  }

  /**
   * SUB-004 "let a user manually add/correct" cancellation steps for a merchant they know the real process
   * for, or one nothing was seeded for at all. Mirrors setMerchantPriceAdjustmentPolicy's own shape/doc
   * comment exactly — the one write path onto merchant_cancellation_steps a non-admin user has, always
   * scoped to this caller only via setUserMerchantCancellationSteps.
   */
  async setMerchantCancellationSteps(merchantId: string, userId: string, dto: SetMerchantCancellationStepsDto): Promise<void> {
    const [merchant] = await this.db.select({ id: schema.merchants.id }).from(schema.merchants).where(eq(schema.merchants.id, merchantId)).limit(1);
    if (!merchant) throw new NotFoundException({ code: "MERCHANT_NOT_FOUND", message: "That merchant doesn't exist." });
    await setUserMerchantCancellationSteps(this.db, userId, merchantId, { steps: dto.steps, sourceNote: dto.sourceNote });
  }

  /** §18 SUB-001..SUB-004 "mark essential/unused" — see SetRecurringStreamEssentialDtoSchema's doc
   * comment; takes a subscriptionId (what the UI already has on hand) and resolves to its stream. */
  async setSubscriptionEssential(subscriptionId: string, userId: string, essential: boolean): Promise<void> {
    const [row] = await this.db
      .select({ stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(eq(schema.subscriptions.id, subscriptionId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "SUBSCRIPTION_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(row.stream.ownerUserId, row.stream.householdId, userId))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    await this.db.update(schema.recurringStreams).set({ essential, updatedAt: new Date() }).where(eq(schema.recurringStreams.id, row.stream.id));
  }

  /** Shared load+access-check for the subscription-lifecycle writes below — same shape as
   * `setSubscriptionEssential`'s own inline lookup just above, factored out for the several new call sites. */
  private async loadSubscriptionForWrite(subscriptionId: string, userId: string) {
    const [row] = await this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(eq(schema.subscriptions.id, subscriptionId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "SUBSCRIPTION_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(row.stream.ownerUserId, row.stream.householdId, userId))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    return row;
  }

  /**
   * §40.3 Subscription state machine — `active → renewal upcoming`, and back to `active` once the renewal
   * date passes with nothing else indicating otherwise. Mirrors AttentionService.scanAndFileDeadlines's own
   * `trial_ending` scan exactly (same "N days before, computed in application code since this date has no
   * dedicated sort column" shape — `recurringStreams.nextExpectedDate`, like `subscriptions.trialEndsAt`,
   * has no `xSort` column of its own) but is NOT wired into that file: attention.service.ts is shared/owned
   * elsewhere this round (its own doc comment says as much — "only ADD read/query logic in
   * commerce.service.ts"). Tests call this directly; wiring it into worker-main.ts's existing hourly
   * attention-scan tick alongside `attention.scanAndFileDeadlines()` is the natural next step once that
   * file is back in scope.
   *
   * The revert-to-active half is this row's own named guardrail: "Transaction disappearance alone does not
   * prove cancellation." Once the renewal date has simply passed with the subscription still sitting in
   * `renewal_upcoming`, the safe default is "it renewed as expected," not "it must have been canceled." A
   * real cancellation only ever moves a subscription to `cancellation_pending` through the explicit
   * `submitSubscriptionCancellation` action below.
   */
  async scanAndAdvanceSubscriptionRenewalStates(now: Date = new Date()): Promise<{ renewalUpcoming: number; reactivated: number }> {
    const window = new Date(now.getTime() + SUBSCRIPTION_RENEWAL_WINDOW_MS);
    const rows = await this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(inArray(schema.subscriptions.state, SUBSCRIPTION_ACTIVE_LIKE_STATES));

    let renewalUpcoming = 0;
    let reactivated = 0;
    for (const row of rows) {
      if (!row.stream.nextExpectedDate) continue;
      const nextSort = temporalToSortDate(row.stream.nextExpectedDate);
      if (!nextSort) continue;

      if (row.subscription.state !== "renewal_upcoming" && nextSort >= now && nextSort <= window) {
        await this.db.update(schema.subscriptions).set({ state: "renewal_upcoming", updatedAt: now }).where(eq(schema.subscriptions.id, row.subscription.id));
        renewalUpcoming++;
      } else if (row.subscription.state === "renewal_upcoming" && nextSort < now) {
        await this.db.update(schema.subscriptions).set({ state: "active", updatedAt: now }).where(eq(schema.subscriptions.id, row.subscription.id));
        reactivated++;
      }
    }
    return { renewalUpcoming, reactivated };
  }

  /**
   * §40.3 Subscription state machine — user-initiated `→ cancellation pending`. The "effective-until-
   * period-end date" the spec names is deliberately NOT a new column: `recurringStreams.nextExpectedDate`
   * (the next billing date this codebase already tracks for every subscription) IS that date — a
   * cancellation submitted mid-cycle takes effect at the end of the current billing period, exactly the
   * date already on file as "when this would otherwise renew." No schema change needed or made.
   */
  async submitSubscriptionCancellation(subscriptionId: string, userId: string): Promise<void> {
    const row = await this.loadSubscriptionForWrite(subscriptionId, userId);
    if (!SUBSCRIPTION_ACTIVE_LIKE_STATES.includes(row.subscription.state) && row.subscription.state !== "trial") {
      throw new BadRequestException({ code: "SUBSCRIPTION_NOT_CANCELABLE", message: "This subscription can't be canceled from its current state." });
    }
    await this.db.update(schema.subscriptions).set({ state: "cancellation_pending", updatedAt: new Date() }).where(eq(schema.subscriptions.id, subscriptionId));
  }

  /**
   * §40.3 Subscription state machine — `cancellation pending → canceled`, once the effective date
   * (`recurringStreams.nextExpectedDate` — see `submitSubscriptionCancellation`'s own doc comment) has
   * passed. A subscription with no known next-expected-date at all can't have its effective date computed,
   * so it's deliberately left pending rather than guessed at.
   */
  async scanAndFinalizeSubscriptionCancellations(now: Date = new Date()): Promise<{ canceled: number }> {
    const rows = await this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(eq(schema.subscriptions.state, "cancellation_pending"));

    let canceled = 0;
    for (const row of rows) {
      if (!row.stream.nextExpectedDate) continue;
      const effectiveSort = temporalToSortDate(row.stream.nextExpectedDate);
      if (effectiveSort && effectiveSort < now) {
        await this.db.update(schema.subscriptions).set({ state: "canceled", updatedAt: now }).where(eq(schema.subscriptions.id, row.subscription.id));
        canceled++;
      }
    }
    return { canceled };
  }

  /**
   * §40.3 Subscription state machine — `active → paused`, gated on `merchantSupportsPause` (see
   * pause-capability.ts's own doc comment on why that allowlist is currently empty: no merchant this
   * codebase knows about offers a real pause option instead of a hard cancel). The state and transition are
   * fully real and exercised by tests; only "which real merchants this applies to" is still unpopulated
   * data. `capableMerchants` defaults to the real allowlist and is never overridden by the controller — it
   * exists purely so a test can exercise a successful pause against a hypothetical pause-capable merchant
   * without mutating the shared module-level allowlist between test runs.
   */
  async pauseSubscription(subscriptionId: string, userId: string, capableMerchants: ReadonlySet<string> = PAUSE_CAPABLE_MERCHANT_NAMES): Promise<void> {
    const row = await this.loadSubscriptionForWrite(subscriptionId, userId);
    const merchantName = row.stream.merchantId ? await this.merchantDisplayName(row.stream.merchantId) : null;
    if (!merchantSupportsPause(merchantName, capableMerchants)) {
      throw new BadRequestException({
        code: "PAUSE_NOT_SUPPORTED",
        message: merchantName ? `${merchantName} doesn't offer a known pause option — cancel instead, or check their site.` : "Pausing isn't available for this subscription yet.",
      });
    }
    if (!SUBSCRIPTION_ACTIVE_LIKE_STATES.includes(row.subscription.state)) {
      throw new BadRequestException({ code: "SUBSCRIPTION_NOT_PAUSABLE", message: "This subscription can't be paused from its current state." });
    }
    await this.db.update(schema.subscriptions).set({ state: "paused", updatedAt: new Date() }).where(eq(schema.subscriptions.id, subscriptionId));
  }

  /** Undoes `pauseSubscription` — a paused subscription resuming is exactly as real-world-common as
   * pausing one in the first place, so this exists for the same reason. */
  async resumeSubscription(subscriptionId: string, userId: string): Promise<void> {
    const row = await this.loadSubscriptionForWrite(subscriptionId, userId);
    if (row.subscription.state !== "paused") {
      throw new BadRequestException({ code: "SUBSCRIPTION_NOT_PAUSED", message: "This subscription isn't paused." });
    }
    await this.db.update(schema.subscriptions).set({ state: "active", updatedAt: new Date() }).where(eq(schema.subscriptions.id, subscriptionId));
  }

  async returns(userId: string) {
    return this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId))
      .orderBy(asc(schema.returnCases.deadlineSort));
  }

  /**
   * MVP §52.1 "Domains: ...shipments..." — found live while auditing this: `shipments` has always had
   * full schema + AI extraction (`IngestionService.extractShipment`), but no list/detail endpoint ever
   * existed for it, unlike every other domain here — there was no way to see a shipment except nested
   * inside its parent purchase's detail. Scoped by `shipments.ownerUserId` directly (not
   * `ownerOrDelegatedHousehold`) because the table has no `householdId` column of its own — see its
   * schema doc comment: a shipment's tracking number isn't globally unique, so ownership had to live
   * directly on the row rather than only being reachable through a purchase join, and a shipment can
   * arrive with no matched purchase at all (`purchaseId` is nullable).
   */
  async shipments(userId: string) {
    return this.db
      .select({ shipment: schema.shipments, purchase: schema.purchases })
      .from(schema.shipments)
      .leftJoin(schema.purchases, eq(schema.purchases.id, schema.shipments.purchaseId))
      .where(eq(schema.shipments.ownerUserId, userId))
      .orderBy(desc(schema.shipments.createdAt));
  }

  async shipmentDetail(shipmentId: string, userId: string) {
    const [row] = await this.db
      .select({ shipment: schema.shipments, purchase: schema.purchases })
      .from(schema.shipments)
      .leftJoin(schema.purchases, eq(schema.purchases.id, schema.shipments.purchaseId))
      .where(eq(schema.shipments.id, shipmentId))
      .limit(1);
    if (!row || row.shipment.ownerUserId !== userId) return null;
    return { shipment: row.shipment, purchase: row.purchase, evidence: await this.evidenceViaInboxItem("shipment", shipmentId) };
  }

  async subscriptions(userId: string) {
    return this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.recurringStreams.ownerUserId, schema.recurringStreams.householdId));
  }

  async bills(userId: string) {
    return this.db
      .select({ bill: schema.bills, stream: schema.recurringStreams })
      .from(schema.bills)
      .leftJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.bills.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.bills.ownerUserId, schema.bills.householdId))
      .orderBy(asc(schema.bills.dueDateSort));
  }

  async warranties(userId: string) {
    return this.db
      .select()
      .from(schema.warranties)
      .where(await this.ownerOrDelegatedHousehold(userId, schema.warranties.ownerUserId, schema.warranties.householdId))
      .orderBy(asc(schema.warranties.expirationDateSort));
  }

  // --- Store credits (Phase 2 §52.2 "advanced returns/refunds/store credits") -----------------------

  async storeCredits(userId: string) {
    const rows = await this.db
      .select({ storeCredit: schema.storeCredits, merchantName: schema.merchants.displayName })
      .from(schema.storeCredits)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.storeCredits.merchantId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.storeCredits.ownerUserId, schema.storeCredits.householdId))
      .orderBy(asc(schema.storeCredits.expirationDateSort));
    return rows.map((r) => ({ ...r.storeCredit, merchantName: r.merchantName }));
  }

  /**
   * Found live while wiring the money-saved dashboard: nothing anywhere ever transitioned a return case
   * out of its default "eligible" state (confirmed by grepping every write to returnCases.state in this
   * codebase) — so a return, once created, had no way to ever be marked as actually completed/refunded,
   * and any "resolved returns" aggregate would always read zero. This is the manual completion step; the
   * automatic version (matching a real bank transaction) now also exists — see
   * PlaidAdapter.matchTransaction's refund-matching block, which sets this same "resolved" state once a
   * matching refund transaction is observed.
   */
  async resolveReturn(returnCaseId: string, userId: string): Promise<void> {
    const [row] = await this.db
      .select({ purchase: schema.purchases, returnCase: schema.returnCases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(eq(schema.returnCases.id, returnCaseId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "RETURN_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(row.purchase.ownerUserId, row.purchase.householdId, userId))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    await this.db.update(schema.returnCases).set({ state: "resolved", updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
    // Bug found live via QA: this legacy manual-completion path (and closeReturn below) moved the RETURN
    // CASE's own state but never told the parent PURCHASE about it — recomputePurchaseOutcomeState exists
    // specifically to promote a purchase to "return_started" once its return has progressed past
    // "eligible" (see initiateReturn's own call to it, and that method's doc comment), but only
    // initiateReturn ever called it; a return resolved straight through this path (or the automatic
    // PlaidAdapter.matchTransaction refund-matching path, which also lands here) left the parent purchase
    // stuck at whatever state it was already in (e.g. "fulfilled") forever, even though its return had
    // actually completed.
    await this.recomputePurchaseOutcomeState(row.purchase.id);
    // Voids the warranty for the specific line item that was returned, if there is one — deliberately
    // scoped to `returnCase.purchaseLineId`, NOT "any warranty anywhere on this purchase": a single order
    // (one `purchases` row) can contain multiple line items, only one of which is what this return case is
    // actually about, so matching on the whole purchase would risk voiding an unrelated item's still-valid
    // warranty. When `purchaseLineId` is null (the return wasn't attributed to one specific line — an older
    // row, or a whole-order return), this deliberately does nothing automatic rather than guessing; a
    // human can still void it by hand if that's ever added. Only ever the *first* voidedAt wins (`isNull`
    // guard) — resolving an already-resolved return a second time (or two returns touching the same line,
    // an edge case not otherwise prevented) must not stomp an earlier void's timestamp.
    if (row.returnCase.purchaseLineId) {
      await this.db
        .update(schema.warranties)
        .set({ voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.warranties.purchaseLineId, row.returnCase.purchaseLineId), isNull(schema.warranties.voidedAt)));
    }
  }

  /** Shared load+access-check for every return-lifecycle write below — same join/ownership-check shape
   * `resolveReturn` above already uses inline, factored out once there are several more call sites. */
  private async loadReturnCaseForWrite(returnCaseId: string, userId: string) {
    const [row] = await this.db
      .select({ purchase: schema.purchases, returnCase: schema.returnCases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(eq(schema.returnCases.id, returnCaseId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "RETURN_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(row.purchase.ownerUserId, row.purchase.householdId, userId))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    return row;
  }

  /**
   * §40.3 Return state machine, step 1 — `eligible → initiated`. `eligible` (the default state a return
   * case is created in — see IngestionService.extractReceipt) just means "still within the return window,
   * nothing done yet"; this is "the user actually started a return." Also promotes the parent purchase to
   * `return_started` via `recomputePurchaseOutcomeState` — see that method's own doc comment for why the
   * return's own further progress (label ready, in transit, refunded, etc) stays on the return case rather
   * than being re-mirrored onto the purchase every step of the way.
   */
  async initiateReturn(returnCaseId: string, userId: string): Promise<void> {
    const row = await this.loadReturnCaseForWrite(returnCaseId, userId);
    if (row.returnCase.state !== "eligible") {
      throw new BadRequestException({ code: "RETURN_NOT_ELIGIBLE", message: "This return has already been started, or is no longer eligible to start." });
    }
    await this.db.update(schema.returnCases).set({ state: "initiated", updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
    await this.recomputePurchaseOutcomeState(row.purchase.id);
  }

  /**
   * §40.3 Return state machine, step 2 — `initiated → label/dropoff ready`. Optionally records real
   * carrier/tracking evidence via the SAME `shipments` table already used for outbound purchase tracking:
   * `shipments.returnCaseId`/`.purchaseId` have both existed since that table was written, and by the same
   * "a shipment can arrive with no matched order" reasoning already in that table's own schema comment, a
   * return shipment can just as well exist with only a `returnCaseId` and no separate purchase-tracking
   * shipment confusion. Reusing this table (rather than adding a parallel one) is what lets
   * `syncReturnShippingStateFromLinkedShipment` below derive `in_transit`/`merchant_received` from the
   * exact same carrier-status vocabulary `IngestionService.extractShipment` already writes for outbound
   * shipments. Both DTO fields are optional — a user may mark a return's label ready before they have a
   * tracking number in hand, or never get one at all for a drop-off-only return, in which case this stays
   * a purely user-reported state with nothing to auto-advance further.
   */
  async markReturnLabelReady(returnCaseId: string, userId: string, dto?: MarkReturnLabelReadyDto): Promise<void> {
    const row = await this.loadReturnCaseForWrite(returnCaseId, userId);
    if (row.returnCase.state !== "initiated") {
      throw new BadRequestException({ code: "RETURN_NOT_INITIATED", message: "Start this return before marking a label/dropoff ready." });
    }
    const patch: Partial<typeof schema.returnCases.$inferInsert> = { state: "label_ready", updatedAt: new Date() };
    if (dto?.trackingNumber !== undefined) patch.trackingNumber = dto.trackingNumber;
    await this.db.update(schema.returnCases).set(patch).where(eq(schema.returnCases.id, returnCaseId));

    if (dto?.trackingNumber) {
      const [existingShipment] = await this.db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.returnCaseId, returnCaseId)).limit(1);
      if (existingShipment) {
        await this.db
          .update(schema.shipments)
          .set({ carrier: dto.carrier ?? "Unknown carrier", trackingNumber: dto.trackingNumber, status: "label_created", updatedAt: new Date() })
          .where(eq(schema.shipments.id, existingShipment.id));
      } else {
        await this.db.insert(schema.shipments).values({
          id: generateId("shipment"),
          ownerUserId: row.purchase.ownerUserId,
          purchaseId: row.purchase.id,
          returnCaseId,
          carrier: dto.carrier ?? "Unknown carrier",
          trackingNumber: dto.trackingNumber,
          status: "label_created",
          isGiftPrivate: false,
        });
      }
    }
  }

  /**
   * §40.3 Return state machine, steps 3-4 — `label/dropoff ready → in transit → merchant received`,
   * derived automatically from the linked return shipment's own carrier status (see
   * `markReturnLabelReady`'s doc comment for why a return reuses the outbound `shipments` status
   * vocabulary) rather than requiring a separate manual "I shipped it"/"they got it" action. A return with
   * no linked shipment (no tracking number was ever recorded — a drop-off return, or one marked
   * label-ready without a tracking number) has nothing to derive from and stays exactly where it is; per
   * this row's own guardrail ("Deadline/policy evidence preserved") that's a user-reported-only return,
   * never guessed at. Not currently wired into any cron — same "tests call this directly, wiring it into a
   * scheduled sweep is the natural next step" posture as `scanAndAdvancePurchaseLifecycle`.
   */
  async syncReturnShippingStateFromLinkedShipment(returnCaseId: string): Promise<void> {
    const [returnCase] = await this.db.select().from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId)).limit(1);
    if (!returnCase) return;
    const [shipment] = await this.db.select({ status: schema.shipments.status }).from(schema.shipments).where(eq(schema.shipments.returnCaseId, returnCaseId)).limit(1);
    if (!shipment) return;

    if (returnCase.state === "label_ready" && (shipment.status === "in_transit" || shipment.status === "out_for_delivery")) {
      await this.db.update(schema.returnCases).set({ state: "in_transit", updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
    } else if ((returnCase.state === "label_ready" || returnCase.state === "in_transit") && shipment.status === "delivered") {
      // "Delivered" from the carrier's point of view IS "merchant received" for a return shipment — the
      // destination on a return leg is the merchant, not the original buyer.
      await this.db.update(schema.returnCases).set({ state: "merchant_received", updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
    }
  }

  /**
   * §40.3 Return state machine, step 5 — `merchant received → refund expected`. Reachable from
   * `merchant_received` (the trackable path) or directly from `label_ready`/`in_transit` for a return whose
   * merchant-received evidence is only ever going to be user-reported — this app has no merchant-side "we
   * received your return" signal at all, only carrier delivery evidence (see
   * `syncReturnShippingStateFromLinkedShipment`'s own doc comment on untracked returns), so gating this
   * strictly on `merchant_received` would strand every untracked return forever.
   */
  async markReturnRefundExpected(returnCaseId: string, userId: string): Promise<void> {
    const row = await this.loadReturnCaseForWrite(returnCaseId, userId);
    if (!["label_ready", "in_transit", "merchant_received"].includes(row.returnCase.state)) {
      throw new BadRequestException({ code: "RETURN_NOT_SHIPPED", message: "Mark this return's label/dropoff ready before expecting a refund." });
    }
    await this.db.update(schema.returnCases).set({ state: "refund_expected", updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
  }

  /**
   * §40.3 Return state machine terminal fork — `refunded / exchanged / disputed / closed`. Reachable from
   * any non-terminal state (not just `refund_expected`) since a merchant can reject a return outright
   * (`disputed`) or offer an exchange before a refund was ever "expected" in the tracked sense — real-world
   * merchant responses don't always respect this app's own tracked shipping steps. Financially-successful
   * outcomes (`refunded`/`exchanged`) also void the return's line-item warranty exactly like `resolveReturn`
   * already does for its own single legacy "resolved" outcome — see that method's own doc comment above for
   * the full reasoning on why this only ever fires for a deterministic single line, and why the first
   * `voidedAt` always wins.
   */
  async closeReturn(returnCaseId: string, userId: string, outcome: CloseReturnDto["outcome"]): Promise<void> {
    const row = await this.loadReturnCaseForWrite(returnCaseId, userId);
    if (RETURN_TERMINAL_STATES.includes(row.returnCase.state)) {
      throw new BadRequestException({ code: "RETURN_ALREADY_CLOSED", message: "This return has already been closed." });
    }
    await this.db.update(schema.returnCases).set({ state: outcome, updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
    // Same gap as resolveReturn's own doc comment just above — recomputePurchaseOutcomeState needs calling
    // for EVERY outcome here, not just the financially-successful ones, since "return_started" on the
    // parent purchase means "a return happened," not "a return succeeded" (see that method's own doc
    // comment on why the return's finer-grained outcome deliberately stays on the return case).
    await this.recomputePurchaseOutcomeState(row.purchase.id);
    if ((outcome === "refunded" || outcome === "exchanged") && row.returnCase.purchaseLineId) {
      await this.db
        .update(schema.warranties)
        .set({ voidedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.warranties.purchaseLineId, row.returnCase.purchaseLineId), isNull(schema.warranties.voidedAt)));
    }
  }

  async storeCreditDetail(storeCreditId: string, userId: string) {
    const [credit] = await this.db.select().from(schema.storeCredits).where(eq(schema.storeCredits.id, storeCreditId)).limit(1);
    if (!credit || !(await this.assertCommerceAccess(credit.ownerUserId, credit.householdId, userId))) return null;
    return { storeCredit: credit, evidence: await this.evidenceForSourceEvent(credit.sourceEventId) };
  }

  /** Manual entry — a goodwill/promo credit with no return behind it has no other way into the system; the AI extractor (ingestion.service.ts's extractStoreCredit) is the automatic path for the common "here's your credit" email case. */
  async createStoreCredit(userId: string, dto: CreateStoreCreditDto): Promise<{ id: string }> {
    const merchantId = dto.merchantName ? await this.findOrCreateMerchant(dto.merchantName) : null;
    const expirationDate: TemporalValue | null = dto.expirationDateIso ? { precision: "date", instantUtc: null, date: dto.expirationDateIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const id = generateId("storeCredit");
    await this.db.insert(schema.storeCredits).values({
      id,
      ownerUserId: userId,
      merchantId,
      amountMinorUnits: dto.amountMinorUnits,
      currency: dto.currency ?? "USD",
      expirationDate,
      expirationDateSort: expirationDate?.date ? new Date(`${expirationDate.date}T00:00:00Z`) : null,
      confidenceBand: "verified", // user-entered directly — same reasoning as AssetsService's manual maintenance records
    });
    return { id };
  }

  async redeemStoreCredit(storeCreditId: string, userId: string): Promise<void> {
    const [credit] = await this.db.select().from(schema.storeCredits).where(eq(schema.storeCredits.id, storeCreditId)).limit(1);
    if (!credit) throw new NotFoundException({ code: "STORE_CREDIT_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(credit.ownerUserId, credit.householdId, userId))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    await this.db.update(schema.storeCredits).set({ redeemed: true, redeemedAt: new Date(), updatedAt: new Date() }).where(eq(schema.storeCredits.id, storeCreditId));
  }

  /**
   * SUB-001 "Identify recurring services from financial transactions, email receipts, app-store receipts,
   * or manual add" — the fourth detection source had no write path at all until now (see
   * CreateSubscriptionDtoSchema's doc comment). Always creates a brand-new recurringStreams + subscriptions
   * pair rather than trying to dedupe against an existing email-discovered stream for the same
   * merchant/service — unlike extractSubscription's own dedup (which only ever runs against that owner's
   * OTHER extracted emails), a manual add is a deliberate user action naming a specific service they know
   * isn't already tracked; silently merging it into a same-named stream on a guess risks attributing a
   * user-entered amount/cadence to a stream an email will later also update. Manual entry gets
   * confidenceBand "verified" (the user is the source of truth) and state "active" (not "candidate" —
   * there's no ambiguity to resolve when a human typed it in directly), the same reasoning
   * CreateStoreCreditDto's own "verified" confidence band uses.
   */
  async createSubscription(userId: string, dto: CreateSubscriptionDto): Promise<{ id: string }> {
    const merchantId = dto.merchantName ? await this.findOrCreateMerchant(dto.merchantName) : null;
    const nextExpectedDate: TemporalValue | null = dto.nextBillingDateIso
      ? { precision: "date", instantUtc: null, date: dto.nextBillingDateIso.slice(0, 10), timezone: null, sourceText: null }
      : null;
    const recurringStreamId = generateId("recurringStream");
    await this.db.insert(schema.recurringStreams).values({
      id: recurringStreamId,
      ownerUserId: userId,
      merchantId,
      serviceLabel: dto.serviceLabel,
      cadence: dto.cadence ?? "irregular",
      typicalAmountMinorUnits: dto.amountMinorUnits ?? null,
      typicalAmountCurrency: dto.amountMinorUnits != null ? (dto.currency ?? "USD") : null,
      nextExpectedDate,
    });
    const subscriptionId = generateId("subscription");
    await this.db.insert(schema.subscriptions).values({
      id: subscriptionId,
      recurringStreamId,
      state: "active",
      confidenceBand: "verified",
    });
    await this.searchIndex?.upsert({
      resourceType: "subscription",
      resourceId: subscriptionId,
      ownerUserId: userId,
      // This manual-add path never sets householdId on the recurring stream either (see its own insert
      // above) — owner-only, matching the row itself.
      householdId: null,
      sensitivity: "sensitive",
      title: dto.serviceLabel,
      bodyText: dto.merchantName ?? "",
    });
    return { id: subscriptionId };
  }

  /**
   * PUR-006/PUR-008 — the manual counterpart to what extraction can never fill in on its own: a serial
   * number (not printed on an order-confirmation email) and a gift flag (buyer intent, not something any
   * document states). Access is scoped through the parent purchase's owner/household exactly like every
   * other commerce write here (resolveReturn, redeemStoreCredit) — `purchase_lines` has no ownerUserId
   * column of its own, only reachable via its parent purchase.
   */
  async updatePurchaseLine(lineId: string, userId: string, dto: UpdatePurchaseLineDto): Promise<void> {
    const [row] = await this.db
      .select({ purchase: schema.purchases })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchaseLines.id, lineId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "PURCHASE_LINE_NOT_FOUND", message: "Not found." });
    // SHARE-001 enforcement — this is the actual write path a purchase grant needs to matter for; requires
    // "edit" so a "view"-only grantee (who could always read this via purchaseDetail) still can't write.
    if (!(await this.assertCommerceAccess(row.purchase.ownerUserId, row.purchase.householdId, userId, { resourceType: "purchase", resourceId: row.purchase.id }, "edit"))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    const patch: Partial<typeof schema.purchaseLines.$inferInsert> = {};
    if (dto.serialNumber !== undefined) patch.serialNumber = dto.serialNumber;
    if (dto.giftFlag !== undefined) patch.giftFlag = dto.giftFlag;
    if (dto.resaleStatus !== undefined) patch.resaleStatus = dto.resaleStatus;
    if (Object.keys(patch).length === 0) return;
    await this.db.update(schema.purchaseLines).set(patch).where(eq(schema.purchaseLines.id, lineId));
    // §40.3 Purchase state machine — a gift/resale flag set here is order-level evidence of the purchase's
    // real terminal outcome (gifted/sold), not just a line-item annotation; see recomputePurchaseOutcomeState's
    // own doc comment for exactly what it does and doesn't override.
    if (dto.giftFlag !== undefined || dto.resaleStatus !== undefined) {
      await this.recomputePurchaseOutcomeState(row.purchase.id);
    }
  }

  /**
   * §40.3 Purchase state machine — `candidate → confirmed → fulfilled/partially fulfilled → kept / return
   * started / gifted / sold / disposed`. Gift/resale/return outcomes were previously only ever visible at
   * the LINE-ITEM level (`purchaseLines.giftFlag`/`.resaleStatus`) with no order-level state reflecting
   * them at all — a fully-gifted or fully-resold order still showed `state: "candidate"` forever, and a
   * return actually being started never moved the parent order off whatever state it was already in. This
   * derives the order-level outcome from the real evidence available today:
   *   1. Any return case beyond `eligible` (a return has actually been started) always wins — "return
   *      started" IS the order-level bucket the spec names; which of refunded/exchanged/disputed/closed it
   *      eventually resolves to stays on the return case itself, not re-mirrored onto the purchase (see
   *      this table's own guardrail, "Line item can differ from order state" — the same precision-first
   *      "don't collapse distinct facts into one shared field" reasoning applies in reverse here too).
   *   2. Every line on the order marked as a gift -> "gifted". A MIXED order (some gifted, some not) is
   *      deliberately NOT called "gifted" — that would misrepresent the lines that weren't — so this only
   *      fires when every line agrees, same all-or-nothing precision-first stance as every dedup heuristic
   *      elsewhere in this codebase (§40.2 "false non-merge is preferable to incorrectly combining").
   *   3. Every line marked "sold" (RET-006 resale handoff) -> "sold", same all-or-nothing reasoning.
   * Never touches a purchase already `state: "disposed"` — the one outcome with no automatic evidence at
   * all (see markPurchaseDisposed's own doc comment) — nor one still `state: "candidate"`: an order that
   * hasn't even been confirmed as real yet has no business being called "gifted"/"sold"/"return started";
   * `scanAndAdvancePurchaseLifecycle` is what settles an unconfirmed candidate toward those states via
   * confirmation/fulfillment first.
   */
  private async recomputePurchaseOutcomeState(purchaseId: string): Promise<void> {
    const [purchase] = await this.db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    if (!purchase || purchase.state === "disposed" || purchase.state === "candidate") return;

    const [lines, returnCasesForPurchase] = await Promise.all([
      this.db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId)),
      this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId)),
    ]);

    const hasActiveOrResolvedReturn = returnCasesForPurchase.some((r) => r.state !== "eligible");
    const allGifted = lines.length > 0 && lines.every((l) => l.giftFlag);
    const allSold = lines.length > 0 && lines.every((l) => l.resaleStatus === "sold");

    const nextState = hasActiveOrResolvedReturn ? "return_started" : allGifted ? "gifted" : allSold ? "sold" : null;
    if (nextState && nextState !== purchase.state) {
      await this.db.update(schema.purchases).set({ state: nextState, updatedAt: new Date() }).where(eq(schema.purchases.id, purchaseId));
    }
  }

  /**
   * §40.3 Purchase state machine, step 1 — `candidate → confirmed`. An explicit user confirmation always
   * moves a candidate forward regardless of confidence band — a human looking at the order and confirming
   * it IS the strongest confidence signal this app can get — while `scanAndAdvancePurchaseLifecycle` below
   * is the automatic path for a high-confidence extraction nobody has looked at yet. A no-op (not an error)
   * once the purchase is already past `candidate`, so a client can call this idempotently.
   */
  async confirmPurchase(purchaseId: string, userId: string): Promise<void> {
    const [purchase] = await this.db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    if (!purchase) throw new NotFoundException({ code: "PURCHASE_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(purchase.ownerUserId, purchase.householdId, userId, { resourceType: "purchase", resourceId: purchaseId }, "edit"))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    if (purchase.state !== "candidate") return;
    await this.db.update(schema.purchases).set({ state: "confirmed", updatedAt: new Date() }).where(eq(schema.purchases.id, purchaseId));
  }

  /**
   * §40.3 Purchase state machine, manual terminal — `disposed`. The one outcome with no automatic evidence
   * anywhere in this codebase (no connector/extractor ever states "the user threw this away"), so unlike
   * kept/gifted/sold/return_started this is exclusively a direct user action — mirrors `updatePurchaseLine`'s
   * reasoning for serialNumber/giftFlag: some facts only a human can assert.
   */
  async markPurchaseDisposed(purchaseId: string, userId: string): Promise<void> {
    const [purchase] = await this.db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    if (!purchase) throw new NotFoundException({ code: "PURCHASE_NOT_FOUND", message: "Not found." });
    if (!(await this.assertCommerceAccess(purchase.ownerUserId, purchase.householdId, userId, { resourceType: "purchase", resourceId: purchaseId }, "edit"))) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
    }
    await this.db.update(schema.purchases).set({ state: "disposed", updatedAt: new Date() }).where(eq(schema.purchases.id, purchaseId));
  }

  /**
   * §40.3 Purchase state machine — the automatic sweep counterpart to confirmPurchase/
   * recomputePurchaseOutcomeState, same "attention-engine timer" shape as
   * AttentionService.scanAndFileDeadlines: a periodic pass that advances every purchase's state from
   * evidence that has since appeared, rather than requiring a user action for every step. Not currently
   * wired into worker-main.ts's hourly attention-scan queue tick — that file (and attention.service.ts
   * itself) is outside this module's ownership this round; tests call this directly, and wiring it in
   * alongside `attention.scanAndFileDeadlines()` is the natural next step once that file is back in scope.
   *
   * Three passes, each re-querying current state so a purchase can advance through more than one step in a
   * single call (e.g. straight from `candidate` to `fulfilled` when a delivered shipment already exists):
   *   1. `candidate` -> `confirmed` for anything at/above the auto-confirm confidence bar.
   *   2. `candidate`/`confirmed` -> `fulfilled` once a linked shipment shows `delivered` — actual delivery
   *      evidence is stronger than a confidence band, so this also promotes a still-`candidate` purchase.
   *      (This codebase's shipment model links a whole shipment to a whole purchase, not to individual
   *      lines, so "partially fulfilled" — named in the spec — has no signal to detect here yet.)
   *   3. `fulfilled` -> its real evidenced outcome via recomputePurchaseOutcomeState (return_started/
   *      gifted/sold), or `kept` once its return window has closed with no return ever started — the
   *      "settles to kept after the return window closes with no action" default outcome. A purchase with
   *      no return case at all settles immediately once fulfilled.
   */
  async scanAndAdvancePurchaseLifecycle(now: Date = new Date()): Promise<{ confirmed: number; fulfilled: number; kept: number }> {
    const confirmCandidates = await this.db
      .select({ id: schema.purchases.id })
      .from(schema.purchases)
      .where(and(eq(schema.purchases.state, "candidate"), inArray(schema.purchases.confidenceBand, PURCHASE_AUTO_CONFIRM_BANDS)));
    if (confirmCandidates.length > 0) {
      await this.db
        .update(schema.purchases)
        .set({ state: "confirmed", updatedAt: now })
        .where(inArray(schema.purchases.id, confirmCandidates.map((p) => p.id)));
    }

    const deliveredShipments = await this.db.select({ purchaseId: schema.shipments.purchaseId }).from(schema.shipments).where(eq(schema.shipments.status, "delivered"));
    const deliveredPurchaseIds = [...new Set(deliveredShipments.map((s) => s.purchaseId).filter((id): id is string => id != null))];
    let fulfilledCount = 0;
    if (deliveredPurchaseIds.length > 0) {
      const fulfillable = await this.db
        .select({ id: schema.purchases.id })
        .from(schema.purchases)
        .where(and(inArray(schema.purchases.id, deliveredPurchaseIds), inArray(schema.purchases.state, ["candidate", "confirmed"])));
      if (fulfillable.length > 0) {
        await this.db
          .update(schema.purchases)
          .set({ state: "fulfilled", updatedAt: now })
          .where(inArray(schema.purchases.id, fulfillable.map((p) => p.id)));
        fulfilledCount = fulfillable.length;
      }
    }

    const fulfilledPurchases = await this.db.select({ id: schema.purchases.id }).from(schema.purchases).where(eq(schema.purchases.state, "fulfilled"));
    let keptCount = 0;
    for (const p of fulfilledPurchases) {
      await this.recomputePurchaseOutcomeState(p.id); // promotes to return_started/gifted/sold when evidenced
      const [current] = await this.db.select({ state: schema.purchases.state }).from(schema.purchases).where(eq(schema.purchases.id, p.id)).limit(1);
      if (current?.state !== "fulfilled") continue; // already moved to a more specific outcome above

      const returnCasesForPurchase = await this.db
        .select({ deadlineSort: schema.returnCases.deadlineSort, state: schema.returnCases.state })
        .from(schema.returnCases)
        .where(eq(schema.returnCases.purchaseId, p.id));
      const windowStillOpen = returnCasesForPurchase.some((r) => r.state === "eligible" && (r.deadlineSort == null || r.deadlineSort > now));
      if (!windowStillOpen) {
        await this.db.update(schema.purchases).set({ state: "kept", updatedAt: now }).where(eq(schema.purchases.id, p.id));
        keptCount++;
      }
    }

    return { confirmed: confirmCandidates.length, fulfilled: fulfilledCount, kept: keptCount };
  }

  /** Best-effort merchant resolution mirroring IngestionService's own findOrCreateMerchant (exact-match, precision-first — see that method's doc comment for why fuzzy matching is deliberately not attempted here either). Duplicated rather than shared across modules for the same reason CommerceService/ScheduleService each keep their own ownerOrDelegatedHousehold: a few lines of logic isn't worth a cross-module coupling. */
  private async findOrCreateMerchant(displayName: string): Promise<string> {
    const [existing] = await this.db.select({ id: schema.merchants.id }).from(schema.merchants).where(eq(schema.merchants.displayName, displayName)).limit(1);
    if (existing) return existing.id;
    const id = generateId("merchant");
    await this.db.insert(schema.merchants).values({ id, displayName });
    return id;
  }

  /**
   * Phase 2 §52.2 "money-saved dashboard" — a purely additive read aggregate (no new write-path
   * complexity): completed returns' value-at-stake, plus redeemed store credits. "Advanced" refund
   * matching against a real bank transaction (this codebase has no financial-aggregator connector yet —
   * see docs/ROADMAP.md's Phase 2 breakdown) would make the returns half of this more automatic, but
   * doesn't change the aggregation itself once a return is genuinely marked resolved.
   *
   * §40.3 Return state machine — counts every financially-successful terminal outcome
   * (`RETURN_SAVINGS_STATES`: the legacy generic "resolved" plus the new named `refunded`/`exchanged`),
   * not just the original single "resolved" state — `disputed` (still unresolved) and `closed` (given up
   * with no refund) are deliberately excluded, same "under-reporting is honest" stance as the currency
   * guard just below.
   *
   * Currency-mismatch fix: every caller of this (life.tsx, home.tsx on both web and mobile) renders the
   * totals as plain USD (`formatMoneyMinorUnits(x, "USD")`, hardcoded) — there's no currency breakdown in
   * the response and no per-user "home currency" concept anywhere in this codebase (checked: no such
   * column exists). But `returnCases.valueAtStakeCurrency`/`storeCredits.currency` are real per-row fields
   * (AI-extracted, or user-entered via CreateStoreCreditDto — see docs/ARCHITECTURE.md's "Money is always
   * `{ minorUnits, currency }`" rule) that are NOT guaranteed to be USD. A plain SQL `sum()` across rows
   * with different currencies silently adds e.g. EUR cents into a USD-labeled total — a wrong number
   * presented with false confidence, not merely an incomplete one. Restricting each sum to `currency =
   * 'USD'` rows only means a non-USD return/credit is (for now) simply not counted in this specific
   * dashboard total, the same "a false non-merge is preferable to incorrectly combining" stance
   * ingestion.service.ts's dedup helpers already take for ambiguous matches — under-reporting is honest,
   * silently mixing currencies is not.
   */
  async savingsSummary(userId: string) {
    const ownerCondition = await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId);
    const [returnsRow] = await this.db
      .select({ total: sum(schema.returnCases.valueAtStakeMinorUnits) })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(and(ownerCondition, inArray(schema.returnCases.state, RETURN_SAVINGS_STATES), eq(schema.returnCases.valueAtStakeCurrency, "USD")));

    const creditOwnerCondition = await this.ownerOrDelegatedHousehold(userId, schema.storeCredits.ownerUserId, schema.storeCredits.householdId);
    const [creditsRow] = await this.db
      .select({ total: sum(schema.storeCredits.amountMinorUnits) })
      .from(schema.storeCredits)
      .where(and(creditOwnerCondition, eq(schema.storeCredits.redeemed, true), eq(schema.storeCredits.currency, "USD")));

    const [outstandingCreditsRow] = await this.db
      .select({ total: sum(schema.storeCredits.amountMinorUnits) })
      .from(schema.storeCredits)
      .where(
        and(
          creditOwnerCondition,
          eq(schema.storeCredits.redeemed, false),
          eq(schema.storeCredits.currency, "USD"),
          or(isNull(schema.storeCredits.expirationDateSort), gt(schema.storeCredits.expirationDateSort, new Date()))!,
        ),
      );

    return {
      resolvedReturnsMinorUnits: Number(returnsRow?.total ?? 0),
      redeemedStoreCreditsMinorUnits: Number(creditsRow?.total ?? 0),
      outstandingStoreCreditsMinorUnits: Number(outstandingCreditsRow?.total ?? 0),
    };
  }

  /**
   * Phase 2 §52.2 "safe-spend awareness" — the spec names this a settings screen ("065. Safe-spend
   * settings") without describing any behavior beyond that, so this is a deliberately modest, honest
   * reading: a normalized monthly-equivalent total of every still-active recurring subscription, compared
   * against an optional user-set cap (`notificationPreferences.monthlySpendCapMinorUnits`). "Awareness"
   * — surfaced for the user to see, not a spending block or an automated cancellation.
   *
   * Cadence normalization is approximate by design (weekly ×52/12, quarterly ÷3, annual ÷12) — an
   * "irregular" cadence has no reliable monthly equivalent and is excluded from the total rather than
   * guessed at. `canceled`/`expired` subscriptions are excluded; every other state (trial, candidate,
   * price_changed, etc.) is still costing money or on track to, so it counts.
   */
  async monthlySpendSummary(userId: string) {
    const rows = await this.db
      .select({
        state: schema.subscriptions.state,
        cadence: schema.recurringStreams.cadence,
        amount: schema.recurringStreams.typicalAmountMinorUnits,
        currency: schema.recurringStreams.typicalAmountCurrency,
      })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.recurringStreams.ownerUserId, schema.recurringStreams.householdId));

    const CADENCE_TO_MONTHLY: Record<string, number> = { weekly: 52 / 12, monthly: 1, quarterly: 1 / 3, annual: 1 / 12 };
    let totalMinorUnits = 0;
    for (const row of rows) {
      if (row.state === "canceled" || row.state === "expired") continue;
      if (row.amount == null) continue;
      // Currency-mismatch fix — same reasoning as savingsSummary just below: this single total is
      // rendered as plain USD by every caller (`formatMoneyMinorUnits(summary.totalMinorUnits, "USD")` in
      // life.tsx on both web and mobile), but `typicalAmountCurrency` is a real per-stream field that can
      // legitimately be non-USD (AI-extracted or user-corrected). Summing a EUR-denominated subscription
      // into a USD-labeled total would silently misstate the number rather than merely omit it.
      if (row.currency !== "USD") continue;
      const factor = CADENCE_TO_MONTHLY[row.cadence];
      if (factor == null) continue; // "irregular" — no reliable monthly equivalent
      totalMinorUnits += Math.round(row.amount * factor);
    }

    const [prefs] = await this.db
      .select({ capMinorUnits: schema.notificationPreferences.monthlySpendCapMinorUnits })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId))
      .limit(1);
    const capMinorUnits = prefs?.capMinorUnits ?? null;

    return { totalMinorUnits, capMinorUnits, overCap: capMinorUnits != null && totalMinorUnits > capMinorUnits };
  }

  // --- Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) --------------------------------------------
  // Purchases only, among everything in this service — bills/warranties/returns/subscriptions/store
  // credits have no sharing endpoint (not asked for; see docs/PHASE2_PENDING_CREDENTIALS.md). Same shape
  // as DocumentsService/ListsService's grant/share-link endpoints, see SharingService's own doc comment.

  /** SHARE-001 "manage = edit + delete + can grant/revoke others' access" — same reasoning as
   * ListsService.assertOwnedOrManagedListForSharing: a "manage"-right grantee on this purchase gets the
   * same re-sharing powers as its owner, but never ownership itself. */
  private async assertOwnedOrManagedPurchaseForSharing(purchaseId: string, userId: string) {
    const [purchase] = await this.db.select().from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    if (!purchase) throw new NotFoundException({ code: "PURCHASE_NOT_FOUND", message: "Not found." });
    if (purchase.ownerUserId === userId) return purchase;
    if (await this.sharing.hasGrantAtLeast("purchase", purchaseId, userId, "manage")) return purchase;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the purchase's owner or a manager can share it." });
  }

  async createResourceGrant(purchaseId: string, requestingUserId: string, granteeEmail: string, expiresInDays?: number, right: ResourceGrantRight = "view", message?: string): Promise<{ id: string }> {
    await this.assertOwnedOrManagedPurchaseForSharing(purchaseId, requestingUserId);
    return this.sharing.createResourceGrant("purchase", purchaseId, requestingUserId, granteeEmail, expiresInDays, right, message);
  }

  async listResourceGrants(purchaseId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPurchaseForSharing(purchaseId, requestingUserId);
    return this.sharing.listResourceGrants("purchase", purchaseId);
  }

  async revokeResourceGrant(grantId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "purchase") return false;
      return (await this.sharing.hasGrantAtLeast("purchase", resourceId, requestingUserId, "manage")) || (await this.isOwnedPurchase(resourceId, requestingUserId));
    });
  }

  async createShareLink(purchaseId: string, requestingUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    await this.assertOwnedOrManagedPurchaseForSharing(purchaseId, requestingUserId);
    return this.sharing.createShareLink("purchase", purchaseId, requestingUserId, dto);
  }

  async listShareLinks(purchaseId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPurchaseForSharing(purchaseId, requestingUserId);
    return this.sharing.listShareLinks("purchase", purchaseId);
  }

  async revokeShareLink(linkId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeShareLink(linkId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "purchase") return false;
      return (await this.sharing.hasGrantAtLeast("purchase", resourceId, requestingUserId, "manage")) || (await this.isOwnedPurchase(resourceId, requestingUserId));
    });
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAccessEvents(purchaseId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPurchaseForSharing(purchaseId, requestingUserId);
    return this.sharing.listAccessEvents("purchase", purchaseId);
  }

  /** SHARE-001 "preview exactly what recipient will see" — reuses publicShareContent, gated the same as
   * the rest of this section. */
  async sharePreview(purchaseId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPurchaseForSharing(purchaseId, requestingUserId);
    return this.publicShareContent(purchaseId);
  }

  private async isOwnedPurchase(purchaseId: string, userId: string): Promise<boolean> {
    const [purchase] = await this.db.select({ ownerUserId: schema.purchases.ownerUserId }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    return purchase?.ownerUserId === userId;
  }

  /** Public, unauthenticated redemption content for a purchase share link — a deliberately narrower view
   * than purchaseDetail's own (no returns/shipments/evidence, which can surface source-email snippets an
   * owner likely didn't mean to hand to an anonymous link recipient): just the purchase's own summary and
   * line items, read-only. */
  async publicShareContent(purchaseId: string) {
    const [row] = await this.db
      .select({ purchase: schema.purchases, merchantName: schema.merchants.displayName })
      .from(schema.purchases)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
      .where(eq(schema.purchases.id, purchaseId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    const lines = await this.db
      .select({
        productLabel: schema.purchaseLines.productLabel,
        quantity: schema.purchaseLines.quantity,
        unitPriceMinorUnits: schema.purchaseLines.unitPriceMinorUnits,
        lineTotalMinorUnits: schema.purchaseLines.lineTotalMinorUnits,
        currency: schema.purchaseLines.currency,
      })
      .from(schema.purchaseLines)
      .where(eq(schema.purchaseLines.purchaseId, purchaseId));
    return {
      merchantName: row.merchantName,
      purchaseDate: row.purchase.purchaseDate,
      totalMinorUnits: row.purchase.totalMinorUnits,
      totalCurrency: row.purchase.totalCurrency,
      lines,
    };
  }
}
