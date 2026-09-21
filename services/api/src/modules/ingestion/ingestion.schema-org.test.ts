import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * Reading the structured data a sender published, end to end through the real pipeline.
 *
 * `schema-org-email.test.ts` proves the parser. This proves the things the parser cannot:
 *
 *   - that `bodyHtml` actually survives `parseGmailMessage` (it did not before — the parser preferred
 *     text/plain and stripped tags from the HTML, so the markup was destroyed before anything saw it);
 *   - that a declared Order routes to the receipt extractor and its stated fields beat the model's;
 *   - that a declared ParcelDelivery files a shipment WITHOUT the shipment extractor being called — the
 *     cost claim, asserted against the model provider's own call log rather than assumed;
 *   - that markup wins field-by-field over the model without discarding what only the model found;
 *   - and that a user who has turned AI processing OFF still gets their orders and deliveries, which is
 *     the behaviour Don chose on 2026-09-20 and the reason this is worth having at all.
 *
 * Every database write is real. Only the model is faked, and the point of most of these is that it is
 * never called.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "t", segmentId: "s", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

/** A Gmail message whose HTML part carries the given ld+json, alongside a plain-text part like a real one. */
function gmailMessageWithMarkup(id: string, subject: string, jsonLd: unknown, plainText = "Thanks for your order.") {
  const html = `<html><body><p>${plainText}</p><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></body></html>`;
  return {
    id,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: "orders@example-outfitters.test" },
        { name: "To", value: "alex@example.com" },
        { name: "Date", value: "Fri, 18 Sep 2026 14:02:11 +0000" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(plainText, "utf8").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from(html, "utf8").toString("base64url") } },
      ],
    },
  };
}

describe("schema.org markup through the ingestion pipeline", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerUserId,
        email: `schemaorg-test-${ownerUserId}@example.com`,
        displayName: "Schema Org Test",
      });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "gmail",
        feasibilityClass: "direct_api",
        scopes: ["gmail.readonly"],
        enabledCategories: ["purchases", "bills"],
        health: "healthy",
      });
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "schema.org ingestion tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  beforeEach(() => {
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
  });

  it("files a purchase from a declared Order, with the sender's stated fields beating the model's", async () => {
    if (!dbAvailable) return;

    const orderNumber = `SO-${generateId("purchase").slice(-10)}`;
    // The model is available and answers — nothing here is faked into failing. It simply states none of
    // the fields the sender did, so every one of them must come from the markup.
    ai.enqueue("receipt_extraction_v1", fakeExtraction({
      merchantName: null,
      orderNumber: null,
      purchaseDate: null,
      totalAmountMinorUnits: null,
      currency: "USD",
      taxMinorUnits: 812,
      shippingMinorUnits: 0,
      lineItems: [],
      returnDeadline: { iso_date: "2026-10-18", approximate_text: null },
      paymentMethodBrand: null,
      paymentMethodLast4: null,
      confidenceNotes: "from the model",
    }));

    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-order-${orderNumber}`, "Your order is confirmed", {
        "@context": "https://schema.org",
        "@type": "Order",
        orderNumber,
        merchant: { "@type": "Organization", name: "Example Outfitters" },
        orderDate: "2026-09-18",
        priceSpecification: { price: "129.99", priceCurrency: "USD" },
        acceptedOffer: [{ "@type": "Offer", itemOffered: { name: "Trail Jacket" }, price: "129.99", priceCurrency: "USD" }],
      }),
    });

    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    const filed = purchases.find((p) => p.orderNumber === orderNumber);
    expect(filed, "no purchase was filed from the declared Order").toBeDefined();
    expect(filed?.totalMinorUnits).toBe(12_999);

    // The markup won every field it stated, over a model answer that stated none of them.
    expect(filed?.orderNumber).toBe(orderNumber);
    // And the classifier still ran, on purpose. It is one cheap call and it can find domains the markup
    // says nothing about — an order confirmation that also registers a warranty is a real message. The
    // saving this feature makes is in the per-domain EXTRACTORS and in the AI-off path, not here; claiming
    // otherwise would have been a saving measured against a capability quietly given up.
    expect(ai.calls).toContain("domain_classifier_v1");
  });

  it("files a shipment from a declared ParcelDelivery without calling the shipment extractor", async () => {
    if (!dbAvailable) return;

    const tracking = `1Z${generateId("shipment").slice(-14).toUpperCase()}`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-parcel-${tracking}`, "Your package is on its way", {
        "@context": "https://schema.org",
        "@type": "ParcelDelivery",
        trackingNumber: tracking,
        carrier: { "@type": "Organization", name: "UPS" },
        expectedArrivalUntil: "2026-09-24",
        deliveryStatus: "https://schema.org/InTransit",
      }),
    });

    const shipments = await db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, ownerUserId));
    const filed = shipments.find((s) => s.trackingNumber === tracking);
    expect(filed, "no shipment was filed from the declared ParcelDelivery").toBeDefined();
    expect(filed?.carrier).toBe("UPS");
    expect(filed?.status).toBe("in_transit");

    // The cost claim, asserted rather than asserted-about: the shipment extractor was never called,
    // because a ParcelDelivery already carries every field a shipment record is made of.
    expect(ai.calls).not.toContain("shipment_extraction_v1");
  });

  it("lets the markup win field by field without discarding what only the model found", async () => {
    if (!dbAvailable) return;

    const orderNumber = `MERGE-${generateId("purchase").slice(-8)}`;
    // The model gets the merchant and the order number WRONG, and is the only source for the return
    // deadline. Both halves of the merge matter: the wrong values must lose, the unique one must survive.
    ai.enqueue("receipt_extraction_v1", fakeExtraction({
      merchantName: "Wrong Merchant Inc",
      orderNumber: "WRONG-0000",
      purchaseDate: { iso_date: "2020-01-01", approximate_text: null },
      totalAmountMinorUnits: 999_99,
      currency: "USD",
      taxMinorUnits: 812,
      shippingMinorUnits: 495,
      lineItems: [],
      returnDeadline: { iso_date: "2026-10-18", approximate_text: null },
      paymentMethodBrand: "Visa",
      paymentMethodLast4: "4242",
      confidenceNotes: "model reading of the prose",
    }));

    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-merge-${orderNumber}`, "Order confirmed", {
        "@context": "https://schema.org",
        "@type": "Order",
        orderNumber,
        merchant: { "@type": "Organization", name: "Example Outfitters" },
        orderDate: "2026-09-18",
        priceSpecification: { price: "129.99", priceCurrency: "USD" },
      }),
    });

    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    const filed = purchases.find((p) => p.orderNumber === orderNumber);

    expect(filed, "the markup's order number did not win").toBeDefined();
    expect(filed?.totalMinorUnits).toBe(12_999); // markup's 129.99, not the model's 999.99
    // And the model's unique contribution survived rather than being thrown away with its wrong fields.
    expect(filed?.paymentMethodHint).toContain("4242");
  });

  it("still extracts for a user who has turned AI processing off", async () => {
    if (!dbAvailable) return;

    // The whole reason this feature is worth having. Before it, this toggle meant a permanently empty
    // inbox — no model, and therefore nothing at all.
    await db.update(schema.users).set({ aiProcessingEnabled: false }).where(eq(schema.users.id, ownerUserId));
    try {
      const tracking = `1Z${generateId("shipment").slice(-14).toUpperCase()}`;
      await ingestion.ingestGmailMessage({
        ownerUserId,
        householdId: null,
        connectionId,
        message: gmailMessageWithMarkup(`msg-aioff-${tracking}`, "Shipped", {
          "@context": "https://schema.org",
          "@type": "ParcelDelivery",
          trackingNumber: tracking,
          carrier: "FedEx",
          expectedArrivalUntil: "2026-09-26",
        }),
      });

      const shipments = await db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, ownerUserId));
      expect(shipments.find((s) => s.trackingNumber === tracking), "AI-off user got nothing from a declared ParcelDelivery").toBeDefined();
      // And emphatically no model was involved in getting it.
      expect(ai.calls).toHaveLength(0);
    } finally {
      await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("files nothing for an AI-off user when the sender published no markup", async () => {
    if (!dbAvailable) return;

    // The opt-out still means what it says. Without markup there is no non-AI way to know what this is,
    // and nothing may be inferred.
    await db.update(schema.users).set({ aiProcessingEnabled: false }).where(eq(schema.users.id, ownerUserId));
    try {
      const before = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: "Your receipt from Somewhere",
        bodyText: "Order 12345. Total $42.00. Thanks for shopping.",
      });
      const after = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
      expect(after).toHaveLength(before.length);
      expect(ai.calls).toHaveLength(0);
    } finally {
      await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("still respects an excluded sender, which is not an AI gate", async () => {
    if (!dbAvailable) return;

    const exclusionId = generateId("connectionExclusion");
    await db.insert(schema.connectionExclusions).values({
      id: exclusionId,
      connectionId,
      excludedSenderDomain: "example-outfitters.test",
    });
    try {
      const tracking = `1Z${generateId("shipment").slice(-14).toUpperCase()}`;
      await ingestion.ingestGmailMessage({
        ownerUserId,
        householdId: null,
        connectionId,
        message: gmailMessageWithMarkup(`msg-excluded-${tracking}`, "Shipped", {
          "@context": "https://schema.org",
          "@type": "ParcelDelivery",
          trackingNumber: tracking,
          carrier: "UPS",
        }),
      });

      const shipments = await db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, ownerUserId));
      // Markup does not get to walk past a gate that was never about AI in the first place.
      expect(shipments.find((s) => s.trackingNumber === tracking)).toBeUndefined();
    } finally {
      await db.delete(schema.connectionExclusions).where(eq(schema.connectionExclusions.id, exclusionId));
    }
  });

  it("files a utility bill from a declared Invoice, with the biller's stated due date", async () => {
    if (!dbAvailable) return;

    const accountLabel = `Account ending ${generateId("bill").slice(-4)}`;
    // The model answers but states none of the fields the biller did, so every one of them must come from
    // the markup. It DOES state an equipment-return obligation, which schema.org has no vocabulary for —
    // that must survive the merge.
    ai.enqueue("bill_extraction_v1", fakeExtraction({
      billerName: null,
      amountDueMinorUnits: null,
      currency: "USD",
      dueDate: null,
      autopayMentioned: null,
      accountLabel: null,
      equipmentReturnDeadline: { iso_date: "2026-06-15", approximate_text: null },
      equipmentReturnInstructions: "Return the modem to any store.",
      confidenceNotes: "from the model",
    }));

    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-invoice-${accountLabel}`, "Your bill is ready", {
        "@context": "https://schema.org",
        "@type": "Invoice",
        accountId: accountLabel,
        paymentDueDate: "2026-05-01",
        paymentStatus: "http://schema.org/PaymentAutomaticallyApplied",
        provider: { "@type": "Organization", name: "City Power & Light" },
        totalPaymentDue: { "@type": "PriceSpecification", price: "84.20", priceCurrency: "USD" },
      }),
    });

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    const filed = bills.find((b) => b.accountLabel === accountLabel);
    expect(filed, "no bill was filed from the declared Invoice").toBeDefined();
    expect(filed?.amountDueMinorUnits).toBe(8_420);
    // The one field this whole path exists for. A bill filed a week late is a late payment and a fee.
    expect(filed?.dueDateSort?.toISOString().slice(0, 10)).toBe("2026-05-01");
    // A declared PaymentAutomaticallyApplied is the biller saying autopay is on.
    expect(filed?.autopayBelieved).toBe(true);
    // And what only the model knew survived the merge.
    expect(filed?.equipmentReturnInstructions).toBe("Return the modem to any store.");
  });

  it("files the bill for a household that has turned AI processing OFF", async () => {
    if (!dbAvailable) return;
    // The whole reason this path is worth having: a biller stating its own due date is not inference, and
    // a privacy choice about AI should not cost somebody a late fee.
    await db.update(schema.users).set({ aiProcessingEnabled: false }).where(eq(schema.users.id, ownerUserId));
    try {
      // A DIFFERENT biller, amount and due date from the test above, on purpose. `findExistingBill` is a
      // precision-first dedup on owner/biller/amount/date-window, so re-filing the same bill correctly
      // UPDATES the first row rather than creating a second — and this test then found no new row and read
      // it as "AI is off and the bill was lost". The dedup was right; the test data was not.
      const accountLabel = `Account ending ${generateId("bill").slice(-4)}`;
      await ingestion.ingestGmailMessage({
        ownerUserId,
        householdId: null,
        connectionId,
        message: gmailMessageWithMarkup(`msg-invoice-noai-${accountLabel}`, "Your water bill is ready", {
          "@context": "https://schema.org",
          "@type": "Invoice",
          accountId: accountLabel,
          paymentDueDate: "2026-07-14",
          provider: { "@type": "Organization", name: "Riverside Water Authority" },
          totalPaymentDue: { "@type": "PriceSpecification", price: "31.75", priceCurrency: "USD" },
        }),
      });

      const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
      expect(bills.find((b) => b.accountLabel === accountLabel), "AI is off and the declared bill was lost with it").toBeDefined();
      // The cost claim, against the provider's own call log rather than assumed.
      expect(ai.calls.filter((c) => c === "bill_extraction_v1").length).toBe(0);
    } finally {
      await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("refuses an Invoice with nobody to pay", async () => {
    if (!dbAvailable) return;
    /**
     * A bill needs a biller. Without one there is nothing to show on a row, nothing to categorise, and —
     * the part that bites later — nothing `findExistingBill` can match on, so every reminder about the
     * same bill would create another sibling row.
     *
     * The guard predates this markup path and was carried into it unchanged. It had no test, which
     * falsification found by deleting it and watching the suite stay green.
     */
    const before = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup("msg-invoice-nobiller", "A bill", {
        "@context": "https://schema.org",
        "@type": "Invoice",
        paymentDueDate: "2026-09-30",
        totalPaymentDue: { "@type": "PriceSpecification", price: "19.99", priceCurrency: "USD" },
      }),
    });
    const after = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(after.length, "a bill with no biller was filed anyway").toBe(before.length);
  });
});
