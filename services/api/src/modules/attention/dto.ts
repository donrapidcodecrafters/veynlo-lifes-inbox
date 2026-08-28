import { z } from "zod";

/**
 * One schema covering every domain "correct" can touch (purchase/bill/calendar_event/shipment) rather
 * than a per-type route — which fields actually apply is decided in InboxService.correct() once the
 * item's linkedResourceType is known, not before. All fields optional: a correction only sends what the
 * user actually changed. Merchant-name correction is deliberately out of scope for now — it would need
 * IngestionService's private findOrCreateMerchant lookup/creation logic, not just a column update.
 */
export const CorrectInboxItemDtoSchema = z.object({
  // purchase
  orderNumber: z.string().max(200).nullable().optional(),
  totalMinorUnits: z.number().int().optional(),
  totalCurrency: z.string().length(3).optional(),
  taxMinorUnits: z.number().int().nullable().optional(),
  shippingMinorUnits: z.number().int().nullable().optional(),
  purchaseDateIso: z.string().min(1).optional(),
  // bill
  billerLabel: z.string().min(1).max(200).optional(),
  amountDueMinorUnits: z.number().int().optional(),
  amountDueCurrency: z.string().length(3).optional(),
  dueDateIso: z.string().min(1).optional(),
  autopayBelieved: z.boolean().optional(),
  // calendar_event
  title: z.string().min(1).max(300).optional(),
  location: z.string().max(300).nullable().optional(),
  isAllDay: z.boolean().optional(),
  startIso: z.string().min(1).optional(),
  endIso: z.string().nullable().optional(),
  // shipment
  carrier: z.string().max(100).optional(),
  trackingNumber: z.string().max(200).optional(),
  status: z.string().max(50).optional(),
  estimatedDeliveryIso: z.string().nullable().optional(),
});
export type CorrectInboxItemDto = z.infer<typeof CorrectInboxItemDtoSchema>;
