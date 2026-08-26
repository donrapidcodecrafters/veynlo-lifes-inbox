import { z } from "zod";
import { MoneySchema } from "../util/money";
import { TemporalValueSchema } from "../util/time";
import { ProvenanceSchema } from "./provenance";

export const MerchantSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  domain: z.string().nullable(),
  logoUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Merchant = z.infer<typeof MerchantSchema>;

/** PUR — purchase state machine (§40.3). */
export const PurchaseStateSchema = z.enum([
  "candidate",
  "confirmed",
  "fulfilled",
  "partially_fulfilled",
  "kept",
  "return_started",
  "gifted",
  "sold",
  "disposed",
]);
export type PurchaseState = z.infer<typeof PurchaseStateSchema>;

export const PurchaseLineSchema = z.object({
  id: z.string(),
  purchaseId: z.string(),
  productLabel: z.string(),
  productMatchEntityId: z.string().nullable(),
  quantity: z.number().int().min(1),
  unitPrice: MoneySchema.nullable(),
  lineTotal: MoneySchema.nullable(),
  serialNumber: z.string().nullable(),
  ownerAssetEntityId: z.string().nullable(),
  giftFlag: z.boolean().default(false),
});
export type PurchaseLine = z.infer<typeof PurchaseLineSchema>;

export const PurchaseSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  merchantId: z.string().nullable(),
  orderNumber: z.string().nullable(),
  purchaseDate: TemporalValueSchema,
  total: MoneySchema.nullable(),
  tax: MoneySchema.nullable(),
  shippingCost: MoneySchema.nullable(),
  paymentMethodHint: z.string().nullable(), // e.g. "Visa •••• 4242" — never full PAN
  state: PurchaseStateSchema,
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Purchase = z.infer<typeof PurchaseSchema>;

/** RET — return case state machine (§40.3, §16). */
export const ReturnCaseStateSchema = z.enum([
  "eligible",
  "initiated",
  "label_ready",
  "in_transit",
  "merchant_received",
  "refund_expected",
  "refunded",
  "exchanged",
  "disputed",
  "closed",
]);
export type ReturnCaseState = z.infer<typeof ReturnCaseStateSchema>;

export const ReturnCaseSchema = z.object({
  id: z.string(),
  purchaseId: z.string(),
  purchaseLineId: z.string().nullable(),
  state: ReturnCaseStateSchema,
  deadline: TemporalValueSchema,
  valueAtStake: MoneySchema.nullable(),
  policyEvidenceId: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  refundExpectedBy: TemporalValueSchema.nullable(),
  refundObservedTransactionId: z.string().nullable(),
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ReturnCase = z.infer<typeof ReturnCaseSchema>;

export const ShipmentStatusSchema = z.enum([
  "label_created",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "exception",
  "returned_to_sender",
  "lost",
]);
export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;

export const ShipmentSchema = z.object({
  id: z.string(),
  purchaseId: z.string().nullable(),
  returnCaseId: z.string().nullable(),
  carrier: z.string(),
  trackingNumber: z.string(),
  status: ShipmentStatusSchema,
  estimatedDelivery: TemporalValueSchema.nullable(),
  deliveredAt: z.string().datetime().nullable(),
  isGiftPrivate: z.boolean().default(false),
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Shipment = z.infer<typeof ShipmentSchema>;

/** SUB — subscription state machine (§40.3, §18). */
export const SubscriptionStateSchema = z.enum([
  "candidate",
  "trial",
  "active",
  "renewal_upcoming",
  "price_changed",
  "paused",
  "cancellation_pending",
  "canceled",
  "expired",
]);
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

export const BillingCadenceSchema = z.enum(["weekly", "monthly", "quarterly", "annual", "irregular"]);
export type BillingCadence = z.infer<typeof BillingCadenceSchema>;

export const RecurringStreamSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  merchantId: z.string().nullable(),
  serviceLabel: z.string(),
  cadence: BillingCadenceSchema,
  typicalAmount: MoneySchema.nullable(),
  nextExpectedDate: TemporalValueSchema.nullable(),
  essential: z.boolean().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RecurringStream = z.infer<typeof RecurringStreamSchema>;

export const SubscriptionSchema = z.object({
  id: z.string(),
  recurringStreamId: z.string(),
  state: SubscriptionStateSchema,
  trialEndsAt: TemporalValueSchema.nullable(),
  cancellationInstructionsUrl: z.string().nullable(),
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const BillSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  recurringStreamId: z.string().nullable(),
  billerLabel: z.string(),
  amountDue: MoneySchema.nullable(),
  dueDate: TemporalValueSchema,
  autopayBelieved: z.boolean().nullable(),
  paymentObservedTransactionId: z.string().nullable(),
  provenance: ProvenanceSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Bill = z.infer<typeof BillSchema>;

export const PriceObservationSchema = z.object({
  id: z.string(),
  subjectEntityId: z.string(), // purchase, product, or recurring stream
  observedAmount: MoneySchema,
  observedAt: z.string().datetime(),
  sourceEventId: z.string(),
});
export type PriceObservation = z.infer<typeof PriceObservationSchema>;
