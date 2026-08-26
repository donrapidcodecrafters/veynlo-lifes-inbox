import { createDbClient } from "../client";
import * as schema from "../schema";

/**
 * Realistic local/demo seed data — one household, two adults, a handful of
 * purchases/returns/subscriptions/bills/documents/events so every screen has
 * something believable to render. Safe to re-run: it upserts by fixed IDs.
 */
async function main() {
  const connectionString =
    process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db = createDbClient(connectionString);
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const daysFromNow = (n: number) => new Date(now.getTime() + n * 86_400_000);

  const userId = "usr_demo_alex";
  const partnerUserId = "usr_demo_jordan";
  const householdId = "hh_demo_rivera";

  await db
    .insert(schema.users)
    .values([
      {
        id: userId,
        email: "alex@example.com",
        displayName: "Alex Rivera",
        locale: "en-US",
        timezone: "America/Chicago",
        currency: "USD",
        status: "active",
        themePreference: "system",
      },
      {
        id: partnerUserId,
        email: "jordan@example.com",
        displayName: "Jordan Rivera",
        locale: "en-US",
        timezone: "America/Chicago",
        currency: "USD",
        status: "active",
        themePreference: "dark",
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.households)
    .values({ id: householdId, name: "The Rivera Household", billingOwnerUserId: userId })
    .onConflictDoNothing();

  await db
    .insert(schema.householdMemberships)
    .values([
      {
        id: "mem_demo_alex",
        householdId,
        userId,
        role: "household_owner",
        relationshipLabel: "self",
        status: "active",
        joinedAt: daysFromNow(-400),
      },
      {
        id: "mem_demo_jordan",
        householdId,
        userId: partnerUserId,
        role: "adult_member",
        relationshipLabel: "spouse",
        status: "active",
        joinedAt: daysFromNow(-390),
      },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.notificationPreferences)
    .values([
      { userId, intensity: "balanced", dailyBriefEnabled: true, weeklyBriefEnabled: true },
      { userId: partnerUserId, intensity: "balanced", dailyBriefEnabled: true, weeklyBriefEnabled: true },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.entitlements)
    .values({
      id: "ent_demo_family",
      userId,
      householdId,
      planKey: "family",
      source: "web_stripe",
      effectiveFrom: daysFromNow(-30),
      effectiveTo: null,
    })
    .onConflictDoNothing();

  const gmailConnectionId = "conn_demo_gmail";
  await db
    .insert(schema.connections)
    .values({
      id: gmailConnectionId,
      ownerUserId: userId,
      householdId,
      provider: "gmail",
      feasibilityClass: "direct_api",
      scopes: ["gmail.readonly"],
      enabledCategories: ["purchases", "deliveries", "bills", "subscriptions", "appointments", "documents"],
      health: "healthy",
      lastSuccessfulSyncAt: daysFromNow(0),
      historyDepthDays: 365,
      itemsDiscoveredCount: 214,
      credentialRef: "credref_demo_gmail",
    })
    .onConflictDoNothing();

  // --- Merchants -----------------------------------------------------------
  const merchants = [
    { id: "mer_amazon", displayName: "Amazon", domain: "amazon.com" },
    { id: "mer_bestbuy", displayName: "Best Buy", domain: "bestbuy.com" },
    { id: "mer_rei", displayName: "REI", domain: "rei.com" },
  ];
  await db.insert(schema.merchants).values(merchants).onConflictDoNothing();

  // --- Purchases + line items + returns + shipments -------------------------
  const laptopPurchaseId = "pur_demo_laptop";
  await db
    .insert(schema.purchases)
    .values({
      id: laptopPurchaseId,
      ownerUserId: userId,
      householdId,
      merchantId: "mer_bestbuy",
      orderNumber: "BB-88213-4471",
      purchaseDate: { precision: "instant", instantUtc: iso(daysFromNow(-9)), date: null, timezone: "America/Chicago", sourceText: null },
      purchaseDateSort: daysFromNow(-9),
      totalMinorUnits: 129900,
      totalCurrency: "USD",
      taxMinorUnits: 9800,
      shippingMinorUnits: 0,
      paymentMethodHint: "Visa •••• 4242",
      state: "fulfilled",
      confidenceBand: "verified",
      sourceEventId: "src_demo_laptop_receipt",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.purchaseLines)
    .values({
      id: "purl_demo_laptop",
      purchaseId: laptopPurchaseId,
      productLabel: 'MacBook Air 15" M3, 16GB/512GB, Midnight',
      quantity: 1,
      unitPriceMinorUnits: 129900,
      lineTotalMinorUnits: 129900,
      currency: "USD",
      serialNumber: "C02FX2QUMD6P",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.returnCases)
    .values({
      id: "ret_demo_laptop",
      purchaseId: laptopPurchaseId,
      purchaseLineId: "purl_demo_laptop",
      state: "eligible",
      deadline: { precision: "date", instantUtc: null, date: iso(daysFromNow(6)).slice(0, 10), timezone: null, sourceText: null },
      deadlineSort: daysFromNow(6),
      valueAtStakeMinorUnits: 129900,
      valueAtStakeCurrency: "USD",
      policyEvidenceId: null,
      trackingNumber: null,
    })
    .onConflictDoNothing();

  const vacuumPurchaseId = "pur_demo_vacuum";
  await db
    .insert(schema.purchases)
    .values({
      id: vacuumPurchaseId,
      ownerUserId: userId,
      householdId,
      merchantId: "mer_amazon",
      orderNumber: "112-4498231-8827412",
      purchaseDate: { precision: "instant", instantUtc: iso(daysFromNow(-3)), date: null, timezone: "America/Chicago", sourceText: null },
      purchaseDateSort: daysFromNow(-3),
      totalMinorUnits: 42999,
      totalCurrency: "USD",
      taxMinorUnits: 3200,
      shippingMinorUnits: 0,
      paymentMethodHint: "Visa •••• 4242",
      state: "confirmed",
      confidenceBand: "verified",
      sourceEventId: "src_demo_vacuum_receipt",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.purchaseLines)
    .values({
      id: "purl_demo_vacuum",
      purchaseId: vacuumPurchaseId,
      productLabel: "Dyson V15 Detect Cordless Vacuum",
      quantity: 1,
      unitPriceMinorUnits: 42999,
      lineTotalMinorUnits: 42999,
      currency: "USD",
    })
    .onConflictDoNothing();

  await db
    .insert(schema.shipments)
    .values({
      id: "shp_demo_vacuum",
      purchaseId: vacuumPurchaseId,
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      status: "out_for_delivery",
      estimatedDelivery: { precision: "date", instantUtc: null, date: iso(daysFromNow(1)).slice(0, 10), timezone: null, sourceText: null },
      isGiftPrivate: false,
    })
    .onConflictDoNothing();

  // --- Recurring streams / subscriptions / bills ---------------------------
  const netflixStreamId = "rec_demo_netflix";
  await db
    .insert(schema.recurringStreams)
    .values({
      id: netflixStreamId,
      ownerUserId: userId,
      householdId,
      merchantId: null,
      serviceLabel: "Netflix Premium",
      cadence: "monthly",
      typicalAmountMinorUnits: 2499,
      typicalAmountCurrency: "USD",
      nextExpectedDate: { precision: "date", instantUtc: null, date: iso(daysFromNow(11)).slice(0, 10), timezone: null, sourceText: null },
      essential: false,
    })
    .onConflictDoNothing();
  await db
    .insert(schema.subscriptions)
    .values({ id: "sub_demo_netflix", recurringStreamId: netflixStreamId, state: "price_changed" })
    .onConflictDoNothing();

  const gymStreamId = "rec_demo_gym";
  await db
    .insert(schema.recurringStreams)
    .values({
      id: gymStreamId,
      ownerUserId: userId,
      householdId,
      serviceLabel: "Equinox Membership",
      cadence: "monthly",
      typicalAmountMinorUnits: 24500,
      typicalAmountCurrency: "USD",
      nextExpectedDate: { precision: "date", instantUtc: null, date: iso(daysFromNow(19)).slice(0, 10), timezone: null, sourceText: null },
      essential: true,
    })
    .onConflictDoNothing();
  await db
    .insert(schema.subscriptions)
    .values({ id: "sub_demo_gym", recurringStreamId: gymStreamId, state: "active" })
    .onConflictDoNothing();

  await db
    .insert(schema.bills)
    .values([
      {
        id: "bil_demo_electric",
        ownerUserId: userId,
        householdId,
        recurringStreamId: null,
        billerLabel: "City Light & Power",
        amountDueMinorUnits: 18420,
        amountDueCurrency: "USD",
        dueDate: { precision: "date", instantUtc: null, date: iso(daysFromNow(4)).slice(0, 10), timezone: null, sourceText: null },
        dueDateSort: daysFromNow(4),
        autopayBelieved: false,
      },
      {
        id: "bil_demo_internet",
        ownerUserId: userId,
        householdId,
        recurringStreamId: null,
        billerLabel: "Fiberlink Internet",
        amountDueMinorUnits: 8900,
        amountDueCurrency: "USD",
        dueDate: { precision: "date", instantUtc: null, date: iso(daysFromNow(14)).slice(0, 10), timezone: null, sourceText: null },
        dueDateSort: daysFromNow(14),
        autopayBelieved: true,
      },
    ])
    .onConflictDoNothing();

  // --- Calendar events / tasks ----------------------------------------------
  await db
    .insert(schema.calendarEvents)
    .values([
      {
        id: "evt_demo_dentist",
        ownerUserId: userId,
        householdId,
        title: "Dentist — Dr. Patel",
        start: { precision: "instant", instantUtc: iso(daysFromNow(2)), date: null, timezone: "America/Chicago", sourceText: null },
        startSort: daysFromNow(2),
        isAllDay: false,
        location: "Riverside Dental",
        source: "google_calendar",
        providerEventId: "gcal_evt_1",
        visibility: "private",
      },
      {
        id: "evt_demo_school_conf",
        ownerUserId: partnerUserId,
        householdId,
        title: "Parent-Teacher Conference — Maya",
        start: { precision: "instant", instantUtc: iso(daysFromNow(5)), date: null, timezone: "America/Chicago", sourceText: null },
        startSort: daysFromNow(5),
        isAllDay: false,
        location: "Lincoln Elementary",
        source: "discovered_from_evidence",
        visibility: "household",
      },
    ])
    .onConflictDoNothing();

  // --- Inbox items ------------------------------------------------------------
  await db
    .insert(schema.inboxItems)
    .values([
      {
        id: "inb_demo_warranty",
        ownerUserId: userId,
        householdId,
        category: "warranty",
        summary: "Dyson V15 warranty registration found — 2-year coverage through 2027-08-23",
        sourceEventId: "src_demo_vacuum_receipt",
        suggestedActions: ["confirm", "file"],
        reviewState: "new",
        confidenceBand: "high",
      },
      {
        id: "inb_demo_flight",
        ownerUserId: userId,
        householdId,
        category: "travel",
        summary: "Flight confirmation to Denver, Oct 14–18, United Airlines",
        sourceEventId: "src_demo_flight",
        suggestedActions: ["confirm", "create_trip"],
        reviewState: "new",
        confidenceBand: "high",
      },
    ])
    .onConflictDoNothing();

  // --- Attention items (Home "Needs You") ------------------------------------
  await db
    .insert(schema.attentionItems)
    .values([
      {
        id: "att_demo_return",
        ownerUserId: userId,
        householdId,
        reasonCode: "return_window_closing",
        reasonText: "Your MacBook Air return window closes in 6 days.",
        urgency: "important",
        dueAt: { precision: "date", instantUtc: null, date: iso(daysFromNow(6)).slice(0, 10), timezone: null, sourceText: null },
        dueAtSort: daysFromNow(6),
        moneyAtStakeMinorUnits: 129900,
        moneyAtStakeCurrency: "USD",
        confidenceBand: "verified",
        linkedResourceType: "purchase",
        linkedResourceId: laptopPurchaseId,
        primaryActions: ["start_return", "keep_item"],
      },
      {
        id: "att_demo_bill",
        ownerUserId: userId,
        householdId,
        reasonCode: "bill_due",
        reasonText: "City Light & Power bill of $184.20 is due in 4 days.",
        urgency: "important",
        dueAt: { precision: "date", instantUtc: null, date: iso(daysFromNow(4)).slice(0, 10), timezone: null, sourceText: null },
        dueAtSort: daysFromNow(4),
        moneyAtStakeMinorUnits: 18420,
        moneyAtStakeCurrency: "USD",
        confidenceBand: "verified",
        primaryActions: ["mark_paid", "open_biller"],
      },
      {
        id: "att_demo_price",
        ownerUserId: userId,
        householdId,
        reasonCode: "subscription_price_increase",
        reasonText: "Netflix Premium increased from $19.99 to $24.99/month.",
        urgency: "useful",
        dueAt: null,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        primaryActions: ["review", "cancel_assist"],
      },
    ])
    .onConflictDoNothing();

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
