import { z } from "zod";

/**
 * Stage-2 domain classifier output (§39.1). Multi-label allowed — a single
 * email can be both a purchase receipt and contain a warranty registration.
 */
export const DomainClassificationResultSchema = z.object({
  domains: z.array(
    z.enum([
      "receipt",
      "shipment",
      "bill",
      "subscription",
      "calendar_event",
      "travel",
      "warranty",
      "identity_document",
      "school",
      "home",
      "vehicle",
      "saved_item",
      "irrelevant",
    ]),
  ),
  reasoning: z.string(),
});
export type DomainClassificationResult = z.infer<typeof DomainClassificationResultSchema>;

/** A date the model is not confident about must come back as `null`, never a fabricated guess (§AI-001/2, "No silent hallucination"). */
const ExtractedDateSchema = z
  .object({
    iso_date: z.string().nullable().describe("YYYY-MM-DD if a specific date is stated; null if unknown or only approximate"),
    approximate_text: z.string().nullable().describe("Original phrase if the date is only approximate, e.g. 'early next month'"),
  })
  .nullable();

export const ReceiptExtractionSchema = z.object({
  merchantName: z.string().nullable(),
  orderNumber: z.string().nullable(),
  purchaseDate: ExtractedDateSchema,
  totalAmountMinorUnits: z.number().int().nullable().describe("Total charged, in minor currency units (cents)"),
  currency: z.string().length(3).default("USD"),
  taxMinorUnits: z.number().int().nullable(),
  shippingMinorUnits: z.number().int().nullable(),
  lineItems: z.array(
    z.object({
      productLabel: z.string(),
      quantity: z.number().int().min(1).default(1),
      unitPriceMinorUnits: z.number().int().nullable(),
    }),
  ),
  returnDeadline: ExtractedDateSchema,
  confidenceNotes: z.string().describe("Anything ambiguous or uncertain about this extraction"),
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

export const BillExtractionSchema = z.object({
  billerName: z.string().nullable(),
  amountDueMinorUnits: z.number().int().nullable(),
  currency: z.string().length(3).default("USD"),
  dueDate: ExtractedDateSchema,
  autopayMentioned: z.boolean().nullable(),
  accountLabel: z.string().nullable(),
  confidenceNotes: z.string(),
});
export type BillExtraction = z.infer<typeof BillExtractionSchema>;

export const CalendarEventExtractionSchema = z.object({
  title: z.string(),
  startDate: ExtractedDateSchema,
  startTime: z.string().nullable().describe("HH:MM 24-hour, in the timezone below, null if only a date is known"),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  isAllDay: z.boolean().default(false),
  confidenceNotes: z.string(),
});
export type CalendarEventExtraction = z.infer<typeof CalendarEventExtractionSchema>;

export const WarrantyExtractionSchema = z.object({
  productLabel: z.string().nullable(),
  warrantyLengthMonths: z.number().int().nullable(),
  warrantyExpirationDate: ExtractedDateSchema,
  registrationConfirmed: z.boolean().nullable(),
  confidenceNotes: z.string(),
});
export type WarrantyExtraction = z.infer<typeof WarrantyExtractionSchema>;
