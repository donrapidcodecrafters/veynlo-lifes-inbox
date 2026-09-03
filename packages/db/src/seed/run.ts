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

  // `credentialRef: "credref_demo_gmail"` below doesn't resolve to a real vault entry — this seed data
  // has never had working Gmail credentials. It's seeded "healthy" for a good out-of-box demo look, but
  // the worker process's recurring connector-scan tick (worker-main.ts) will legitimately flip this to
  // "degraded" within 15 minutes of actually running, once it tries a real incremental sync against a
  // credential that isn't there. That's correct behavior, not a bug — a non-functional connection
  // shouldn't stay reported as healthy forever just because it's demo data.
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

  // --- Source events -----------------------------------------------------
  // Backing rows for the sourceEventId FKs purchases/inbox items below point at — without these, the
  // "evidence" view (GET /v1/purchases/:id etc.) has nothing to join to and silently returns null, even
  // though the join code itself is correct. Content is deliberately generic demo text, not a real email.
  await db
    .insert(schema.sourceEvents)
    .values([
      {
        id: "src_demo_laptop_receipt",
        ownerUserId: userId,
        householdId,
        kind: "email",
        contentHash: "demo-laptop-receipt",
        occurredAt: daysFromNow(-9),
        subjectLine: "Your Best Buy order has shipped",
        snippet: 'Your MacBook Air 15" M3 order #BB-88213-4471 is on its way.',
        fromAddress: "orders@bestbuy.com",
        processingState: "filed",
        idempotencyKey: "demo-laptop-receipt",
      },
      {
        id: "src_demo_vacuum_receipt",
        ownerUserId: userId,
        householdId,
        kind: "email",
        contentHash: "demo-vacuum-receipt",
        occurredAt: daysFromNow(-3),
        subjectLine: "Your Amazon.com order has shipped",
        snippet: "Your Dyson V15 Detect Cordless Vacuum order #112-4498231-8827412 is on its way.",
        fromAddress: "shipment-tracking@amazon.com",
        processingState: "filed",
        idempotencyKey: "demo-vacuum-receipt",
      },
      {
        id: "src_demo_flight",
        ownerUserId: userId,
        householdId,
        kind: "email",
        contentHash: "demo-flight",
        occurredAt: daysFromNow(-2),
        subjectLine: "Your United Airlines flight confirmation",
        snippet: "Confirmation for your flight to Denver, Oct 14-18.",
        fromAddress: "confirmation@united.com",
        processingState: "filed",
        idempotencyKey: "demo-flight",
      },
    ])
    .onConflictDoNothing();

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
      ownerUserId: userId,
      purchaseId: vacuumPurchaseId,
      carrier: "UPS",
      trackingNumber: "1Z999AA10123456784",
      status: "out_for_delivery",
      estimatedDelivery: { precision: "date", instantUtc: null, date: iso(daysFromNow(1)).slice(0, 10), timezone: null, sourceText: null },
      isGiftPrivate: false,
    })
    .onConflictDoNothing();

  // Same reasoning as ret_demo_laptop below: gives Life → Warranties a real evidence-linked row instead of
  // only an unpromoted inbox item pointing nowhere (found live — see inb_demo_warranty's linkedResourceType
  // just below, which used to be left unset entirely).
  const vacuumWarrantyId = "war_demo_vacuum";
  await db
    .insert(schema.warranties)
    .values({
      id: vacuumWarrantyId,
      ownerUserId: userId,
      householdId,
      purchaseLineId: "purl_demo_vacuum",
      productLabel: "Dyson V15 Detect Cordless Vacuum",
      warrantyLengthMonths: 24,
      expirationDate: { precision: "date", instantUtc: null, date: iso(daysFromNow(-3 + 730)).slice(0, 10), timezone: null, sourceText: null },
      expirationDateSort: daysFromNow(-3 + 730),
      confidenceBand: "high",
      registrationConfirmed: true,
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
        linkedResourceType: "warranty",
        linkedResourceId: vacuumWarrantyId,
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
        // Must match AttentionService.scanAndFileDeadlines' own convention for a return-window item
        // exactly (linkedResourceType "return_case" + the return case's own id, not the purchase's) —
        // that's the dedup key `fileIfNew` checks before inserting. This row previously pointed at
        // {type: "purchase", id: laptopPurchaseId} instead, so the real recurring scan job never
        // recognized this as already-filed and created a genuine duplicate attention item for the same
        // return every time it ran.
        linkedResourceType: "return_case",
        linkedResourceId: "ret_demo_laptop",
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
        // Same fix as att_demo_return above — this row had no linkedResourceType/linkedResourceId at all,
        // so the scanner could never recognize it as already-filed either.
        linkedResourceType: "bill",
        linkedResourceId: "bil_demo_electric",
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

  // Phase 2 §52.2 "automation/rule center" — without this, a fresh seed had zero example of the new
  // feature to look at. `sub_demo_netflix` (seeded above with state "price_changed") is a real,
  // already-matching trigger event for this rule, so the run below reads as genuinely earned rather than
  // fabricated: this is exactly what a real price-change email would have produced.
  const demoRuleId = "rule_demo_price_alert";
  await db
    .insert(schema.automationRules)
    .values({
      id: demoRuleId,
      ownerUserId: userId,
      householdId,
      name: "Notify me whenever a subscription price changes",
      naturalLanguageSource: "Notify me whenever a subscription price changes",
      triggerDescriptor: JSON.stringify({ kind: "new_subscription", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null }),
      actionDescriptor: JSON.stringify({ kind: "notify", message: "A subscription price just changed.", taskTitle: null, eventTitle: null, daysFromNow: null }),
      riskTier: "L0",
      approvalMode: "confirm_each_time",
      enabled: true,
    })
    .onConflictDoNothing();
  await db
    .insert(schema.automationRuns)
    .values({
      id: "run_demo_price_alert",
      ruleId: demoRuleId,
      triggerEvidenceId: "sub_demo_netflix",
      state: "approval_required",
      idempotencyKey: `${demoRuleId}:subscription:sub_demo_netflix`,
      commandsJson: { kind: "notify", message: "A subscription price just changed.", taskTitle: null, eventTitle: null, daysFromNow: null },
    })
    .onConflictDoNothing();

  // §AI-002 "Confidence and risk policy" — `risk_policies` existed with zero rows and zero readers; every
  // extractor used one global {reviewThreshold: 0.55, highThreshold: 0.85} pair regardless of stakes. These
  // are the first real, deliberately conservative policy rows: money-moving domains (a bill amount, a
  // purchase total, a recurring subscription charge) require a HIGHER bar of model confidence before a fact
  // is trusted as "high"/auto-acceptable, matching the spec's own "domain + field + action impact" framing.
  // "shipment" is the deliberate low-stakes contrast — a wrong tracking number costs nothing but a refresh,
  // so it's allowed to reach "high" at a lower confidence than the global default. Every other domain has no
  // row here and keeps using the exact same global default as before (see RiskPolicyService's own doc
  // comment for the fallback order) — this is additive, not a behavior change for anything not listed below.
  await db
    .insert(schema.riskPolicies)
    .values([
      { id: "rpol_demo_receipt", domain: "receipt", field: "*", reviewThreshold: 0.65, autoAcceptThreshold: 0.92, policyVersion: "v1" },
      { id: "rpol_demo_bill", domain: "bill", field: "*", reviewThreshold: 0.7, autoAcceptThreshold: 0.93, policyVersion: "v1" },
      { id: "rpol_demo_subscription", domain: "subscription", field: "*", reviewThreshold: 0.65, autoAcceptThreshold: 0.9, policyVersion: "v1" },
      { id: "rpol_demo_shipment", domain: "shipment", field: "*", reviewThreshold: 0.45, autoAcceptThreshold: 0.75, policyVersion: "v1" },
    ])
    .onConflictDoNothing();

  console.log("Seed complete.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
