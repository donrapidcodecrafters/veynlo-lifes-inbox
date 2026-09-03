import { z } from "zod";

export const CreateStoreCreditDtoSchema = z.object({
  merchantName: z.string().min(1).max(200).nullable().optional(),
  amountMinorUnits: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  expirationDateIso: z.string().nullable().optional(),
});
export type CreateStoreCreditDto = z.infer<typeof CreateStoreCreditDtoSchema>;

/**
 * SUB-001 "Identify recurring services from financial transactions, email receipts, app-store receipts,
 * OR MANUAL ADD" — found live while re-auditing §18: `extractSubscription` (the email path) and
 * `CreateStoreCreditDto`'s manual-entry sibling both existed, but nothing let a user manually add a
 * subscription/recurring stream that was never evidenced by an email at all (a cash-only gym membership,
 * a subscription paid by a family member's card that never forwards receipt emails, etc.) — the fourth of
 * SUB-001's four named detection sources had no way in. Mirrors CreateStoreCreditDtoSchema's shape exactly:
 * merchantName is optional/best-effort (a subscription doesn't always have a separate billing merchant
 * from the service itself), amount/currency/cadence/nextBillingDateIso are all optional since a user may
 * only know some of them at add-time and can leave the rest for a later email to fill in.
 */
export const CreateSubscriptionDtoSchema = z.object({
  serviceLabel: z.string().min(1).max(200),
  merchantName: z.string().min(1).max(200).nullable().optional(),
  cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "irregular"]).optional(),
  amountMinorUnits: z.number().int().positive().nullable().optional(),
  currency: z.string().length(3).optional(),
  nextBillingDateIso: z.string().nullable().optional(),
});
export type CreateSubscriptionDto = z.infer<typeof CreateSubscriptionDtoSchema>;

/**
 * PUR-006/PUR-008 — `purchase_lines.serialNumber` and `.giftFlag` have had real columns (and, for
 * serialNumber, real display in the purchase-detail UI) since the receipt-extraction write path was
 * built, but nothing anywhere ever let a user set either one — the AI extractor doesn't emit a serial
 * number (never printed on an order-confirmation email) and no endpoint ever wrote `giftFlag`. Both are
 * exactly the kind of thing the spec calls out as a manual `User action` ("add serial/model",
 * "mark gift/returned/sold"), not something extraction alone can ever fully cover. Both fields optional —
 * a correction only sends what the user actually changed, same convention as CorrectInboxItemDtoSchema.
 */
/**
 * RET-006 "Resale handoff" — `resaleStatus` is the one piece of state this feature actually persists (see
 * packages/db/src/schema/commerce.ts's purchaseLines.resaleStatus doc comment for why the listing draft
 * itself — title/description/condition — is deliberately NOT persisted). Same optional-patch shape as
 * serialNumber/giftFlag above: a status update only sends what changed.
 */
export const ResaleStatusSchema = z.enum(["not_listed", "listed", "sold"]);

export const UpdatePurchaseLineDtoSchema = z.object({
  serialNumber: z.string().max(200).nullable().optional(),
  giftFlag: z.boolean().optional(),
  resaleStatus: ResaleStatusSchema.optional(),
});
export type UpdatePurchaseLineDto = z.infer<typeof UpdatePurchaseLineDtoSchema>;

/**
 * §18 SUB-001..SUB-004 "User actions: ... mark essential/unused ..." — recurringStreams.essential has
 * had a real column since the schema was written, but (confirmed live while auditing §18 by grepping
 * every write to it) nothing anywhere ever set it — the subscription detail UI has always shown
 * "Essential: Unknown" with no way to change that. Same "manual action the extractor can't cover" shape
 * as UpdatePurchaseLineDtoSchema above: whether a subscription is essential is a judgment call only the
 * user can make.
 */
export const SetRecurringStreamEssentialDtoSchema = z.object({ essential: z.boolean() });
export type SetRecurringStreamEssentialDto = z.infer<typeof SetRecurringStreamEssentialDtoSchema>;

/**
 * Phase 2 §52.2 "service/warranty/maintenance history" — `warranties.propertyProfileId`/
 * `.vehicleProfileId`/`.homeAssetId` (packages/db/src/schema/commerce.ts) were read everywhere a warranty
 * needed to resolve "which house/vehicle/asset is this for," but nothing ever wrote them — a warranty
 * extracted from a receipt email has no way to know it's about a specific home appliance unless a human
 * links it. Mirrors health-logistics's LinkBillToAppointmentDtoSchema: a focused, single-purpose "set this
 * link" DTO rather than folding into a general-purpose PATCH.
 *
 * All three fields are independently optional/nullable partial-patch semantics (only a field actually
 * present in the body is changed; `null` explicitly clears it) — same convention as
 * UpdatePurchaseLineDtoSchema above. propertyProfileId/vehicleProfileId are refined below to never both be
 * set at once (non-null) in the same request, matching the schema comment's "never both set for one row"
 * invariant — CommerceService.linkWarrantyToAsset also re-derives the row's post-patch state and enforces
 * the same rule there, since a request could set one of the two fields while the OTHER was already set
 * from an earlier link.
 */
export const LinkWarrantyToAssetDtoSchema = z
  .object({
    propertyProfileId: z.string().min(1).nullable().optional(),
    vehicleProfileId: z.string().min(1).nullable().optional(),
    homeAssetId: z.string().min(1).nullable().optional(),
  })
  .refine((dto) => !(dto.propertyProfileId && dto.vehicleProfileId), {
    message: "A warranty can be linked to a property or a vehicle, never both.",
  });
export type LinkWarrantyToAssetDto = z.infer<typeof LinkWarrantyToAssetDtoSchema>;

/**
 * RET-004 "Policy engine ... let a user manually add/correct a policy for a merchant they know the real
 * terms for" — the inline policy editor on the purchase-detail page's price-adjustment banner posts this.
 * Always becomes a "user_confirmed" row scoped to the caller (see CommerceService.setMerchantPriceAdjustmentPolicy
 * and price-adjustment-policy.ts's own doc comment) — there's no confidence field here because a user
 * asserting a fact about a merchant is definitionally "user_confirmed," never "commonly_known"/"assumed"
 * (those only ever come from the seeded reference data).
 */
export const SetMerchantPriceAdjustmentPolicyDtoSchema = z.object({
  windowDays: z.number().int().positive().max(3650),
  sourceNote: z.string().max(500).nullable().optional(),
});
export type SetMerchantPriceAdjustmentPolicyDto = z.infer<typeof SetMerchantPriceAdjustmentPolicyDtoSchema>;

/**
 * SUB-004 "Cancellation assistant ... shows known steps" — the same "let a user manually add/correct a
 * fact they know better than the seeded reference data" pattern as SetMerchantPriceAdjustmentPolicyDtoSchema
 * above, applied to merchant_cancellation_steps. Always becomes a row scoped to the caller (see
 * CommerceService.setMerchantCancellationSteps and merchant-cancellation-steps.ts's own doc comment) —
 * there's no confidence field here, same reasoning as the price-adjustment DTO: a user asserting steps for
 * a merchant is definitionally their own correction, never the seeded global fact.
 */
export const SetMerchantCancellationStepsDtoSchema = z.object({
  steps: z.array(z.string().min(1).max(300)).min(1).max(20),
  sourceNote: z.string().max(500).nullable().optional(),
});
export type SetMerchantCancellationStepsDto = z.infer<typeof SetMerchantCancellationStepsDtoSchema>;

/**
 * §40.3 Return state machine — `eligible → initiated → label/dropoff ready → in transit → merchant
 * received → refund expected → refunded / exchanged / disputed / closed`. `markReturnLabelReady` is the
 * one step a user can attach real carrier/tracking evidence to (the same `shipments` table already used
 * for outbound purchase tracking — see CommerceService.markReturnLabelReady's own doc comment for why a
 * return shipment reuses that table via its existing, previously-always-null `returnCaseId` column rather
 * than a new one); both fields are optional since a user may mark a return's label ready before they have
 * a tracking number in hand, or never get one at all for a drop-off-only return.
 */
export const MarkReturnLabelReadyDtoSchema = z.object({
  carrier: z.string().min(1).max(100).nullable().optional(),
  trackingNumber: z.string().min(1).max(200).nullable().optional(),
});
export type MarkReturnLabelReadyDto = z.infer<typeof MarkReturnLabelReadyDtoSchema>;

/**
 * §40.3 Return state machine terminal fork — `refunded / exchanged / disputed / closed`. Replaces the old
 * single generic "resolved" outcome (see CommerceService.resolveReturn's own doc comment, kept unchanged
 * for backward compatibility) with the real, distinct outcomes the spec names, so `savingsSummary` and any
 * future reporting can tell "refunded" apart from "gave up and closed it" or "still disputing it."
 */
export const CloseReturnDtoSchema = z.object({
  outcome: z.enum(["refunded", "exchanged", "disputed", "closed"]),
});
export type CloseReturnDto = z.infer<typeof CloseReturnDtoSchema>;
