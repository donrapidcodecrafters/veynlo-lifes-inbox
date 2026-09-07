import type { createDbClient } from "../client";
import * as schema from "../schema";
import type { CoverageContext } from "./coverage";

/**
 * Fills the areas that were STILL empty after run.ts and coverage.ts.
 *
 * coverage.ts's own header promises "EVERY user-facing area and EVERY category within it has at least one
 * row". Measured against a freshly seeded database, that was not true: **39 of 134 tables held zero rows**,
 * and **31 of those 39 are read by the API** — so they back real screens that were rendering their empty
 * state on every device, in every theme, on both machines.
 *
 * Why that matters more than it sounds: an empty screen cannot distinguish "this control is broken" from
 * "there is nothing here to act on". Every device pass run against those areas was verifying an empty
 * state and recording it as coverage. Whole features — all of Finance, all of School & Activities, store
 * credits, travel estimates, schedule conflicts, permission forms, data-export history — had never been
 * seen with data by any pass.
 *
 * DELIBERATELY NOT SEEDED — the remaining 8 tables the API never reads:
 *   smart_connections, smart_devices, device_signals — smart-home.ts says in its own header that this is
 *     "DATA MODEL ONLY, with zero live connectors", that nothing writes a connected row and no UI presents
 *     one. Seeding them would manufacture coverage for a screen that does not exist.
 *   batch_actions, deep_link_routes, desktop_device_settings, local_cache_manifest, entity_merge_lineage —
 *     desktop-local or lineage tables written only by runtime flows, with no API read path.
 * Those are recorded as intentionally empty rather than quietly counted as done.
 *
 * Idempotent, like coverage.ts: every insert is keyed on a fixed id with onConflictDoNothing.
 */

type Db = ReturnType<typeof createDbClient>;

export async function seedEmptyAreas(db: Db, ctx: CoverageContext): Promise<void> {
  const { userId, partnerUserId, householdId, now } = ctx;
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const iso = (d: Date) => d.toISOString();
  const dateOnly = (n: number) => iso(day(n)).slice(0, 10);
  // Several columns are TemporalValue jsonb, not timestamps — the paired *Sort column is the timestamp.
  const onDate = (n: number) => ({ precision: "date" as const, instantUtc: null, date: dateOnly(n), timezone: null, sourceText: null });
  const atInstant = (n: number) => ({ precision: "instant" as const, instantUtc: iso(day(n)), date: null, timezone: "America/Chicago", sourceText: null });

  // ── Family: dependents ──────────────────────────────────────────────────────────────────────────
  // Nothing else in the school/permission-form chain can exist without these, and the Household screen's
  // dependent list was empty on every device.
  await db
    .insert(schema.dependentProfiles)
    .values([
      { id: "dep_seed_maya", householdId, displayName: "Maya Rivera", birthDate: "2014-03-19", guardianUserIds: [userId, partnerUserId] },
      { id: "dep_seed_theo", householdId, displayName: "Theo Rivera", birthDate: "2018-11-02", guardianUserIds: [userId] },
    ])
    .onConflictDoNothing();

  // ── School & Activities ─────────────────────────────────────────────────────────────────────────
  // Both source kinds, so the ICS and forwarding-email branches each have a row behind them.
  await db
    .insert(schema.schools)
    .values([
      { id: "sch_seed_elm", householdId, name: "Elmwood Middle School", address: "1420 Elmwood Ave, Oak Park, IL 60302" },
      { id: "sch_seed_rec", householdId, name: "Northside Rec Center — Swim Team", address: "88 Lakeshore Dr, Chicago, IL 60611" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.schoolSources)
    .values([
      { id: "scs_seed_ics", schoolId: "sch_seed_elm", householdId, createdByUserId: userId, kind: "ics", label: "Elmwood 7th-grade calendar", icsUrl: "https://example.invalid/elmwood-7th.ics", health: "healthy", lastSuccessfulSyncAt: day(-1), itemsDiscoveredCount: 12 },
      { id: "scs_seed_email", schoolId: "sch_seed_rec", householdId, createdByUserId: userId, kind: "forwarding_email", label: "Swim team announcements", icsUrl: null as string | null, health: "needs_attention", lastSuccessfulSyncAt: null as Date | null, itemsDiscoveredCount: 0 },
    ])
    .onConflictDoNothing();

  // Past and future, all-day and timed, with and without dropoff/pickup — the combinations the School
  // screen groups and badges by.
  await db
    .insert(schema.schoolEvents)
    .values([
      { id: "sce_seed_conference", ownerUserId: userId, householdId, schoolId: "sch_seed_elm", schoolSourceId: "scs_seed_ics", dependentId: "dep_seed_maya", kind: "conference", title: "Parent–teacher conference — Maya", description: "15-minute slot with Ms. Alvarez. Bring the reading log.", start: atInstant(6), startSort: day(6), isAllDay: false, location: "Elmwood Middle School, Room 214", arrivalNote: "Doors open 10 minutes early; park on Elmwood Ave.", requiresDropoff: false, requiresPickup: false, confidenceBand: "verified", status: "confirmed" },
      { id: "sce_seed_fieldtrip", ownerUserId: userId, householdId, schoolId: "sch_seed_elm", schoolSourceId: "scs_seed_ics", dependentId: "dep_seed_maya", kind: "field_trip", title: "Field trip — Museum of Science and Industry", start: onDate(13), startSort: day(13), isAllDay: true, requiresDropoff: true, requiresPickup: true, arrivalNote: "Bus leaves at 7:45am sharp — earlier than normal drop-off.", confidenceBand: "high", status: "confirmed" },
      { id: "sce_seed_meet", ownerUserId: userId, householdId, schoolId: "sch_seed_rec", schoolSourceId: "scs_seed_email", dependentId: "dep_seed_theo", kind: "activity", title: "Swim meet — Northside Invitational", start: atInstant(-9), startSort: day(-9), isAllDay: false, location: "Northside Rec Center", requiresPickup: true, confidenceBand: "needs_review", status: "confirmed" },
    ])
    .onConflictDoNothing();

  // Every permission_form_state value, so the status filter has a row behind each option.
  await db
    .insert(schema.permissionForms)
    .values([
      { id: "pmf_seed_discovered", ownerUserId: userId, householdId, schoolId: "sch_seed_elm", dependentId: "dep_seed_maya", schoolEventId: "sce_seed_fieldtrip", title: "Field trip permission slip — Museum of Science and Industry", state: "discovered", dueDate: onDate(9), dueDateSort: day(9), confidenceBand: "high" },
      { id: "pmf_seed_opened", ownerUserId: userId, householdId, schoolId: "sch_seed_elm", dependentId: "dep_seed_maya", title: "Photo/media release — 2026/27 school year", state: "opened", dueDate: onDate(20), dueDateSort: day(20), confidenceBand: "verified" },
      { id: "pmf_seed_completed", ownerUserId: userId, householdId, schoolId: "sch_seed_rec", dependentId: "dep_seed_theo", title: "Swim team medical questionnaire", state: "completed", dueDate: onDate(-4), dueDateSort: day(-4), confidenceBand: "verified" },
      { id: "pmf_seed_submitted", ownerUserId: userId, householdId, schoolId: "sch_seed_elm", dependentId: "dep_seed_theo", title: "Emergency contact update form", state: "submitted", dueDate: onDate(-15), dueDateSort: day(-15), confidenceBand: "verified" },
      { id: "pmf_seed_confirmed", ownerUserId: userId, householdId, schoolId: "sch_seed_elm", dependentId: "dep_seed_maya", title: "Band instrument rental agreement", state: "confirmed", dueDate: onDate(-30), dueDateSort: day(-30), confidenceBand: "verified" },
    ])
    .onConflictDoNothing();

  // ── Finance ─────────────────────────────────────────────────────────────────────────────────────
  // The entire Finance surface was empty: no accounts, so no transactions, income streams or liabilities
  // could exist either.
  await db
    .insert(schema.financialAccounts)
    .values([
      { id: "fac_seed_checking", connectionId: "conn_demo_gmail", ownerUserId: userId, plaidAccountId: "seed-plaid-checking", name: "Everyday Checking", officialName: "Meridian Bank Everyday Checking", type: "depository", subtype: "checking", mask: "4412", currentBalanceMinorUnits: 428_15, availableBalanceMinorUnits: 401_02, currency: "USD", isIncluded: true },
      { id: "fac_seed_savings", connectionId: "conn_demo_gmail", ownerUserId: userId, plaidAccountId: "seed-plaid-savings", name: "Emergency Fund", officialName: "Meridian Bank High-Yield Savings", type: "depository", subtype: "savings", mask: "9930", currentBalanceMinorUnits: 812_640, availableBalanceMinorUnits: 812_640, currency: "USD", isIncluded: true },
      // Excluded on purpose so the "not included" presentation has a row.
      { id: "fac_seed_card", connectionId: "conn_demo_gmail", ownerUserId: userId, plaidAccountId: "seed-plaid-card", name: "Rewards Card", officialName: "Meridian Signature Rewards Visa", type: "credit", subtype: "credit card", mask: "1187", currentBalanceMinorUnits: -1_284_33, currency: "USD", isIncluded: false },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.financialTransactions)
    .values([
      { id: "ftx_seed_grocery", accountId: "fac_seed_checking", ownerUserId: userId, plaidTransactionId: "seed-tx-grocery", name: "HARVEST MARKET #221", merchantName: "Harvest Market", amountMinorUnits: -142_87, currency: "USD", category: ["groceries"], pending: false, postedDate: dateOnly(-3), matchedBillId: null },
      { id: "ftx_seed_pending", accountId: "fac_seed_card", ownerUserId: userId, plaidTransactionId: "seed-tx-pending", name: "AMAZON MKTPLACE", merchantName: "Amazon", amountMinorUnits: -68_40, currency: "USD", category: ["shopping"], pending: true, postedDate: null as string | null, matchedBillId: null },
      { id: "ftx_seed_payroll", accountId: "fac_seed_checking", ownerUserId: userId, plaidTransactionId: "seed-tx-payroll", name: "NORTHWIND LLC PAYROLL", merchantName: "Northwind LLC", amountMinorUnits: 3_142_88, currency: "USD", category: ["income"], pending: false, postedDate: dateOnly(-5), matchedBillId: null },
      // Matched to a real bill, so the "matched" presentation is exercised rather than only unmatched rows.
      { id: "ftx_seed_electric", accountId: "fac_seed_checking", ownerUserId: userId, plaidTransactionId: "seed-tx-electric", name: "CITY LIGHT & POWER AUTOPAY", merchantName: "City Light & Power", amountMinorUnits: -118_44, currency: "USD", category: ["utilities"], pending: false, postedDate: dateOnly(-12), matchedBillId: "bil_demo_electric" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.transactionRevisions)
    .values([
      // A pending charge that later posted at a different amount — the case the revision history exists for.
      { id: "trv_seed_amazon", financialTransactionId: "ftx_seed_pending", ownerUserId: userId, accountId: "fac_seed_card", plaidTransactionId: "seed-tx-pending", amountMinorUnits: -71_10, pending: true, postedDate: dateOnly(-1), reason: "amount_changed" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.detectedIncomeStreams)
    .values([
      { id: "inc_seed_payroll", ownerUserId: userId, accountId: "fac_seed_checking", streamKey: "northwind-payroll", description: "Northwind LLC — semi-monthly payroll", cadence: "semi_monthly", averageAmountMinorUnits: 3_142_88, currency: "USD", occurrenceCount: 14, lastOccurrenceDate: dateOnly(-5) },
      // Dismissed, so the dismissed/hidden branch has a row too.
      { id: "inc_seed_side", ownerUserId: userId, accountId: "fac_seed_checking", streamKey: "etsy-payouts", description: "Etsy shop payouts", cadence: "irregular", averageAmountMinorUnits: 96_20, currency: "USD", occurrenceCount: 5, lastOccurrenceDate: dateOnly(-22), dismissedAt: day(-20) },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.liabilities)
    .values([
      { id: "lia_seed_card", accountId: "fac_seed_card", ownerUserId: userId, minimumPaymentMinorUnits: 45_00, dueDate: dateOnly(11), aprBasisPoints: 2199, lastStatementBalanceMinorUnits: 1_284_33, lastSyncedAt: day(-1) },
    ])
    .onConflictDoNothing();

  // ── Commerce: store credits ─────────────────────────────────────────────────────────────────────
  // Redeemed, outstanding and expiring-soon, because the Money tab totals and the expiry warning each
  // need their own row to be provable.
  await db
    .insert(schema.storeCredits)
    .values([
      { id: "stc_seed_outstanding", ownerUserId: userId, householdId, merchantId: "mer_amazon", amountMinorUnits: 45_00, currency: "USD", expirationDate: onDate(120), expirationDateSort: day(120), sourceReturnCaseId: "ret_demo_laptop", redeemed: false, confidenceBand: "verified" },
      { id: "stc_seed_expiring", ownerUserId: userId, householdId, merchantId: "mer_amazon", amountMinorUnits: 20_00, currency: "USD", expirationDate: onDate(9), expirationDateSort: day(9), redeemed: false, confidenceBand: "high" },
      { id: "stc_seed_redeemed", ownerUserId: userId, householdId, merchantId: "mer_amazon", amountMinorUnits: 15_50, currency: "USD", redeemed: true, redeemedAt: day(-14), confidenceBand: "verified" },
    ])
    .onConflictDoNothing();

  // ── Calendar reschedule (CAL-002) ───────────────────────────────────────────────────────────────
  await db
    .insert(schema.calendarRescheduleTrustedRules)
    .values([{ id: "crt_seed_dental", ownerUserId: userId, senderDomain: "riversidedental.example" }])
    .onConflictDoNothing();

  await db
    .insert(schema.calendarRescheduleProposals)
    .values([
      { id: "crp_seed_dentist", inboxItemId: "inb_demo_warranty", calendarEventId: "evt_demo_dentist", ownerUserId: userId, senderDomain: "riversidedental.example", proposedStart: atInstant(4), proposedIsAllDay: false, proposedLocation: "Riverside Dental — Suite 300 (moved from Suite 210)" },
    ])
    .onConflictDoNothing();

  // ── Automation: prepared actions ────────────────────────────────────────────────────────────────
  await db
    .insert(schema.preparedActions)
    .values([
      { id: "pac_seed_cancel", runId: "run_demo_price_alert", ownerUserId: userId, householdId, merchantId: "mer_amazon", title: "Cancel the unused Prime Video channel add-on", steps: ["Open Account & Settings", "Choose Channels", "Select Cancel Channel", "Confirm cancellation"], sourceNote: "Steps drafted from the merchant's published help page.", state: "pending" },
      { id: "pac_seed_confirmed", runId: "run_demo_price_alert", ownerUserId: userId, householdId, title: "Request a price adjustment on the laptop stand", steps: ["Open the order", "Choose Problem with order", "Select Price changed after purchase"], state: "confirmed", confirmedAt: day(-2) },
    ])
    .onConflictDoNothing();

  // ── Location: travel estimates ──────────────────────────────────────────────────────────────────
  await db
    .insert(schema.travelEstimates)
    .values([
      { id: "tve_seed_home_work", ownerUserId: userId, originPlaceId: "plc_seed_home", destinationPlaceId: "plc_seed_work", distanceMeters: 18_400, estimatedMinutes: 34, method: "driving", uncertaintyNote: "Straight-line estimate with a traffic allowance; not a live routing result." },
    ])
    .onConflictDoNothing();

  // ── Data export history ─────────────────────────────────────────────────────────────────────────
  // A completed export and a failed one, so both presentations exist on the Data Export screen.
  await db
    .insert(schema.exportJobs)
    .values([
      { id: "exp_seed_done", ownerUserId: userId, state: "completed", storageKey: "exports/usr_demo_alex/seed-export.zip", requestedAt: day(-6), completedAt: day(-6), expiresAt: day(1), selectedCategories: ["documents", "purchases"], itemCount: 128, estimatedSizeBytes: 4_812_000 },
      { id: "exp_seed_failed", ownerUserId: userId, state: "failed", errorMessage: "The export timed out while packaging attachments. Try again, or pick fewer categories.", requestedAt: day(-2), completedAt: day(-2) },
    ])
    .onConflictDoNothing();

  // ── Schedule conflicts ──────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.scheduleConflicts)
    .values([
      { id: "scf_seed_overlap", householdId, kind: "overlap", involvedEventIds: ["evt_demo_dentist"], severity: "important", detectedAt: day(-1), occurrenceDate: dateOnly(4) },
    ])
    .onConflictDoNothing();

  // ── Connector hygiene ───────────────────────────────────────────────────────────────────────────
  // connection_credentials being empty is why the connector-sync queue could never succeed from the seed:
  // conn_demo_gmail carries a credentialRef pointing at a vault entry that did not exist.
  await db
    .insert(schema.connectionCredentials)
    .values([
      { id: "credref_demo_gmail", connectionId: "conn_demo_gmail", encryptedPayload: "seed-not-a-real-credential-payload", encryptionKeyId: "seed-dev-key", expiresAt: day(30) },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.connectionExclusions)
    .values([{ id: "cex_seed_newsletter", connectionId: "conn_demo_gmail", excludedSenderDomain: "newsletters.example" }])
    .onConflictDoNothing();

  await db
    .insert(schema.webhookSubscriptions)
    .values([
      { id: "whs_seed_gmail", connectionId: "conn_demo_gmail", provider: "gmail", externalId: "seed-watch-1", channelSecretHash: "seed-not-a-real-secret-hash", expiresAt: day(6), renewedAt: day(-1) },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.syncRuns)
    .values([
      { id: "syn_seed_ok", connectionId: "conn_demo_gmail", kind: "incremental", status: "completed", startedAt: day(-1), completedAt: day(-1), itemsProcessed: 42, pagesCompleted: 3 },
      { id: "syn_seed_failed", connectionId: "conn_demo_gmail", kind: "initial", status: "failed", startedAt: day(-8), completedAt: day(-8), itemsProcessed: 11, errorDetail: "The provider returned 429 while paging; the run stopped and will resume from its checkpoint." },
    ])
    .onConflictDoNothing();

  // ── Ingestion provenance ────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.evidenceRefs)
    .values([
      { id: "evr_seed_receipt", sourceEventId: "src_demo_laptop_receipt", locator: "email:body:offset=1180", excerpt: "Return window closes 30 days after delivery.", capturedAt: day(-20) },
    ])
    .onConflictDoNothing();

  // extractor_versions ids are generated at seed time, so this has to look one up rather than hardcode a
  // reference — an invented id fails the FK and takes the whole seed down with it.
  const [extractorVersion] = await db.select({ id: schema.extractorVersions.id }).from(schema.extractorVersions).limit(1);
  if (extractorVersion) {
    await db
      .insert(schema.extractionRuns)
      .values([
        { id: "exr_seed_ok", sourceEventId: "src_demo_laptop_receipt", stage: "extract", extractorVersionId: extractorVersion.id, status: "succeeded", costMinorUnits: 2, latencyMs: 1840, startedAt: day(-20), completedAt: day(-20), errorDetail: null as string | null },
        { id: "exr_seed_failed", sourceEventId: "src_demo_laptop_receipt", stage: "classify", extractorVersionId: extractorVersion.id, status: "failed", costMinorUnits: 0, latencyMs: 9120, errorDetail: "Schema validation failed twice; the item was left for manual review.", startedAt: day(-19), completedAt: day(-19) },
      ])
      .onConflictDoNothing();
  }

  await db
    .insert(schema.promptSecurityEvents)
    .values([
      { id: "pse_seed_injection", userId, sourceEventId: "src_demo_laptop_receipt", kind: "prompt_injection_suspected", detail: "Message body contained an instruction addressed to the assistant; content was quarantined and not acted on." },
    ])
    .onConflictDoNothing();

  // ── Identity: renewal links ─────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.jurisdictionRenewalLinks)
    .values([
      { id: "jrl_seed_il_dl", recordType: "drivers_license", jurisdiction: "US-IL", ownerUserId: userId, url: "https://example.invalid/il-dl-renewal", label: "Illinois SOS — driver's licence renewal", sourceNote: "Seeded reference link; not a live URL." },
    ])
    .onConflictDoNothing();

  // ── Widgets & app intents ───────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.widgetPreferences)
    .values([
      { id: "wgp_seed_needs_you", userId, widgetKind: "needs_you", privacyMode: "full", enabled: true },
      // A masked widget as well, so the privacy-mode presentation is testable rather than assumed.
      { id: "wgp_seed_money", userId, widgetKind: "money_at_risk", privacyMode: "hide_amounts", enabled: true },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.appIntentLog)
    .values([
      { id: "ail_seed_widget", userId, platform: "ios", intentKind: "widget_tap", resourceType: "bill", resourceId: "bil_demo_electric", outcome: "opened" },
      { id: "ail_seed_failed", userId, platform: "android", intentKind: "deep_link", resourceType: "document", resourceId: "doc_seed_passport", outcome: "not_found" },
    ])
    .onConflictDoNothing();

  // ── Billing history ─────────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.billingEvents)
    .values([
      { id: "ble_seed_sub", userId, source: "stripe", externalEventId: "seed-evt-sub-created", eventType: "customer.subscription.created", payloadJson: { seeded: true, plan: "plus" }, processedAt: day(-45) },
    ])
    .onConflictDoNothing();

  // ── Model registry / eval history (admin screens) ───────────────────────────────────────────────
  await db
    .insert(schema.modelRegistry)
    .values([
      { id: "mdl_seed_primary", provider: "anthropic", modelKey: "seed-primary-model", tier: "primary", displayName: "Seeded Primary Extractor", supportedTasks: ["extract", "classify"], maxContextTokens: 200_000, structuredOutputReliability: "high", latencyClass: "medium", costClass: "medium", regions: ["us"], launchStatus: "ga" },
      { id: "mdl_seed_deprecated", provider: "anthropic", modelKey: "seed-legacy-model", tier: "fallback", displayName: "Seeded Legacy Extractor", supportedTasks: ["extract"], maxContextTokens: 100_000, structuredOutputReliability: "medium", latencyClass: "fast", costClass: "low", regions: ["us"], launchStatus: "deprecated", deprecatedAt: day(-90), sunsetAt: day(60) },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.modelEvalRuns)
    .values([
      { id: "mev_seed_pass", modelKey: "seed-primary-model", goldenSetVersion: "v3", totalCases: 120, passedCases: 114, passRate: 0.95, triggeredBy: "seed", runAt: day(-7) },
      { id: "mev_seed_regress", modelKey: "seed-legacy-model", goldenSetVersion: "v3", totalCases: 120, passedCases: 88, passRate: 0.7333, triggeredBy: "seed", runAt: day(-7) },
    ])
    .onConflictDoNothing();

  // ── Partner-owned rows ──────────────────────────────────────────────────────────────────────────
  // The partner account needs its own data too, or every "shared with me" / two-account check is run
  // against an empty second tenant.
  await db
    .insert(schema.widgetPreferences)
    .values([{ id: "wgp_seed_partner", userId: partnerUserId, widgetKind: "needs_you", privacyMode: "generic", enabled: false }])
    .onConflictDoNothing();
}
