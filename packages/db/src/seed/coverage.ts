import type { createDbClient } from "../client";
import * as schema from "../schema";

/**
 * Coverage seed — guarantees EVERY user-facing area and EVERY category within it has at least one row.
 *
 * Why this is separate from run.ts: run.ts seeds a believable *demo* (a household with a few purchases
 * and bills). That is the right shape for a screenshot, but it leaves most tables empty, so whole screens
 * — Documents, Places, Lists, Saved, Trips, Life/People/Pets/Properties/Vehicles, Identity, Health,
 * Sender Rules, Entities — render their empty state, and every filter, tab and toggle on them is
 * untestable. An empty screen cannot tell you whether a control works or merely has nothing to act on.
 *
 * The rule here is deliberately stronger than "some data everywhere": where a screen filters by a
 * category enum, EVERY value of that enum gets at least one row (all 7 list kinds, all 12 memory
 * categories, all 5 sender-rule actions, all 4 trip-segment kinds). A filter value with no rows behind it
 * is a filter nobody can prove works.
 *
 * Deliberately varied, not uniform: rows differ in state, urgency, dates (past AND future), assignment,
 * checked/unchecked, pinned/archived, and text length — including some deliberately long labels, because
 * uniform short rows hide truncation, wrapping, sorting and grouping defects.
 *
 * Idempotent: every insert is keyed on a fixed id with onConflictDoNothing, so re-running is safe.
 */

type Db = ReturnType<typeof createDbClient>;

export interface CoverageContext {
  userId: string;
  partnerUserId: string;
  householdId: string;
  now: Date;
}

export async function seedCoverage(db: Db, ctx: CoverageContext): Promise<void> {
  const { userId, partnerUserId, householdId, now } = ctx;
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000);
  const iso = (d: Date) => d.toISOString();
  const onDate = (n: number) => ({
    precision: "date" as const,
    instantUtc: null,
    date: iso(day(n)).slice(0, 10),
    timezone: null,
    sourceText: null,
  });
  const atInstant = (n: number) => ({
    precision: "instant" as const,
    instantUtc: iso(day(n)),
    date: null,
    timezone: "America/Chicago",
    sourceText: null,
  });

  // ── Documents ───────────────────────────────────────────────────────────────────────────────────
  // Covers every documentType the app actually uses, emergency-binder and ordinary, plus expired /
  // expiring-soon / never-expires so expiry sorting and warning states all have a real row.
  // `blobRef` points at object keys that do NOT exist in MinIO: these rows exist for list, detail and
  // filter testing, and a download attempt will legitimately fail. Seeding a fake blob would be worse —
  // it would make a broken download look like a working one.
  const docs = [
    { id: "doc_seed_passport", type: "passport", title: "US Passport — Alex Rivera", kind: "identity", binder: true, exp: 400, sens: "highly_sensitive" as const },
    { id: "doc_seed_license", type: "drivers_license", title: "Illinois Driver's License", kind: "identity", binder: true, exp: 120, sens: "highly_sensitive" as const },
    { id: "doc_seed_insurance", type: "insurance_policy", title: "Homeowners Policy — Meridian Mutual HO-3", kind: "insurance", binder: true, exp: 210, sens: "sensitive" as const },
    { id: "doc_seed_autoins", type: "insurance_policy", title: "Auto Insurance — Meridian Mutual", kind: "insurance", binder: true, exp: -12, sens: "sensitive" as const },
    { id: "doc_seed_title", type: "title", title: "Vehicle Title — 2019 Subaru Outback", kind: "ownership", binder: true, exp: null, sens: "highly_sensitive" as const },
    { id: "doc_seed_receipt", type: "receipt", title: "Best Buy receipt — MacBook Air 15-inch M3", kind: "purchase", binder: false, exp: null, sens: "standard" as const },
    { id: "doc_seed_warranty", type: "warranty", title: "Dyson V15 Detect — 2-year limited warranty", kind: "warranty", binder: false, exp: 700, sens: "standard" as const },
    { id: "doc_seed_medical", type: "medical", title: "Immunization record — Maya Rivera", kind: "medical", binder: true, exp: null, sens: "highly_sensitive" as const },
    { id: "doc_seed_will", type: "will", title: "Last Will and Testament — executed copy", kind: "legal", binder: true, exp: null, sens: "secret" as const },
    { id: "doc_seed_lease", type: "other", title: "Storage unit rental agreement — Unit 214, Northgate Self Storage", kind: "legal", binder: false, exp: 45, sens: "sensitive" as const },
  ];
  await db
    .insert(schema.documents)
    .values(
      docs.map((d) => ({
        id: d.id,
        ownerUserId: userId,
        householdId,
        documentType: d.type,
        title: d.title,
        sensitivity: d.sens,
        visibility: d.sens === "secret" ? ("private" as const) : ("household" as const),
        isEmergencyBinderItem: d.binder,
        documentKind: d.kind,
        expiresAt: d.exp === null ? null : onDate(d.exp),
        expiresAtSort: d.exp === null ? null : day(d.exp),
        processingState: "verified",
        verifiedAt: day(-20),
        currentVersionId: `${d.id}_v1`,
        tags: [d.kind],
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(schema.documentVersions)
    .values(
      docs.map((d) => ({
        id: `${d.id}_v1`,
        documentId: d.id,
        versionNumber: 1,
        blobRef: `seed/${d.id}.pdf`,
        contentHash: `seedhash-${d.id}`,
        mimeType: "application/pdf",
        sizeBytes: 184_320,
        ocrText: `${d.title} — seeded OCR text, present so document search and the detail view have real content to match against.`,
        ocrConfidence: 0.94,
      })),
    )
    .onConflictDoNothing();

  // A second version on one document, so version history has a real multi-version case: a single-version
  // list can't demonstrate ordering or which version is current.
  await db
    .insert(schema.documentVersions)
    .values({
      id: "doc_seed_insurance_v2",
      documentId: "doc_seed_insurance",
      versionNumber: 2,
      blobRef: "seed/doc_seed_insurance_v2.pdf",
      contentHash: "seedhash-doc_seed_insurance-v2",
      mimeType: "application/pdf",
      sizeBytes: 191_004,
      ocrText: "Homeowners Policy — Meridian Mutual HO-3. Renewal endorsement, revised dwelling coverage.",
      ocrConfidence: 0.91,
    })
    .onConflictDoNothing();

  // ── Places, geofences, context rules ────────────────────────────────────────────────────────────
  const places = [
    { id: "plc_seed_home", label: "Home", address: "1428 Elmwood Ave, Oak Park, IL 60302", lat: 41.8881, lng: -87.7845 },
    { id: "plc_seed_work", label: "Office — Loop", address: "233 S Wacker Dr, Chicago, IL 60606", lat: 41.8789, lng: -87.6359 },
    { id: "plc_seed_school", label: "Lincoln Elementary", address: "1111 S Grove Ave, Oak Park, IL 60304", lat: 41.8712, lng: -87.7901 },
    { id: "plc_seed_vet", label: "Riverside Animal Hospital", address: "88 Harlem Ave, Forest Park, IL 60130", lat: 41.8742, lng: -87.8067 },
    { id: "plc_seed_moms", label: "Mom's house", address: "7 Lakeview Ter, Madison, WI 53703", lat: 43.0731, lng: -89.4012 },
    // Deliberately no coordinates: the schema allows null lat/lng, and a place with no geocode must still
    // render in list and detail rather than breaking the distance/map UI.
    { id: "plc_seed_storage", label: "Northgate Self Storage — Unit 214", address: null, lat: null, lng: null },
  ];
  await db
    .insert(schema.places)
    .values(
      places.map((p) => ({
        id: p.id,
        ownerUserId: userId,
        householdId,
        label: p.label,
        address: p.address,
        lat: p.lat,
        lng: p.lng,
        source: "manual",
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(schema.geofences)
    .values([
      { id: "gef_seed_home", ownerUserId: userId, placeId: "plc_seed_home", radiusMeters: 150, triggerKind: "arrival", isActive: true },
      { id: "gef_seed_school", ownerUserId: userId, placeId: "plc_seed_school", radiusMeters: 200, triggerKind: "arrival", isActive: true },
      // Inactive on purpose — active and inactive render differently and both need a row.
      { id: "gef_seed_work", ownerUserId: userId, placeId: "plc_seed_work", radiusMeters: 250, triggerKind: "departure", isActive: false },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.contextRules)
    .values([
      { id: "ctx_seed_home", ownerUserId: userId, geofenceId: "gef_seed_home", actionKind: "remind", actionTitle: "Bring in the package on the porch", actionPayload: {}, isActive: true },
      { id: "ctx_seed_school", ownerUserId: userId, geofenceId: "gef_seed_school", actionKind: "remind", actionTitle: "Sign Maya's field-trip permission slip", actionPayload: {}, isActive: true },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.geofenceEvents)
    .values([
      { id: "gfe_seed_1", ownerUserId: userId, geofenceId: "gef_seed_home", triggerKind: "arrival", contextRuleFired: true, occurredAt: day(-1) },
      { id: "gfe_seed_2", ownerUserId: userId, geofenceId: "gef_seed_school", triggerKind: "arrival", contextRuleFired: false, occurredAt: day(-4) },
    ])
    .onConflictDoNothing();

  // Foreground granted / background denied is the most common real-world combination and the one the
  // Places permission banner exists for — a fully-granted state would hide that banner entirely.
  await db
    .insert(schema.locationPermissionState)
    .values({ userId, foregroundStatus: "granted", backgroundStatus: "denied", precision: "precise" })
    .onConflictDoNothing();

  // ── Lists — all 7 list kinds ────────────────────────────────────────────────────────────────────
  const lists = [
    { id: "lst_seed_grocery", kind: "grocery" as const, name: "Weekly groceries" },
    { id: "lst_seed_packing", kind: "packing" as const, name: "Denver trip — packing" },
    { id: "lst_seed_maint", kind: "household_maintenance" as const, name: "Fall house maintenance" },
    { id: "lst_seed_gift", kind: "gift" as const, name: "Holiday gift ideas" },
    { id: "lst_seed_school", kind: "school_supplies" as const, name: "Maya — 4th grade supplies" },
    { id: "lst_seed_tripprep", kind: "trip_prep" as const, name: "Before we leave for Denver" },
    { id: "lst_seed_custom", kind: "custom" as const, name: "Someday / maybe" },
  ];
  await db
    .insert(schema.lists)
    .values(lists.map((l) => ({ id: l.id, ownerUserId: userId, householdId, name: l.name, kind: l.kind })))
    .onConflictDoNothing();

  // One archived list, so "archived" has something to hide and an archive view has something to show.
  await db
    .insert(schema.lists)
    .values({ id: "lst_seed_archived", ownerUserId: userId, householdId, name: "Summer camp prep (done)", kind: "custom", archivedAt: day(-30) })
    .onConflictDoNothing();

  const items: Array<{ id: string; listId: string; label: string; checked?: boolean; assigned?: string; priv?: boolean; pos: number }> = [
    { id: "sit_seed_g1", listId: "lst_seed_grocery", label: "Whole milk (2 gal)", pos: 0 },
    { id: "sit_seed_g2", listId: "lst_seed_grocery", label: "Sourdough loaf", checked: true, pos: 1 },
    { id: "sit_seed_g3", listId: "lst_seed_grocery", label: "Coffee beans — the dark roast Jordan likes, not the breakfast blend", assigned: partnerUserId, pos: 2 },
    { id: "sit_seed_g4", listId: "lst_seed_grocery", label: "Dog food — large bag", pos: 3 },
    { id: "sit_seed_p1", listId: "lst_seed_packing", label: "Hiking boots", pos: 0 },
    { id: "sit_seed_p2", listId: "lst_seed_packing", label: "Altitude sickness tablets", checked: true, pos: 1 },
    { id: "sit_seed_p3", listId: "lst_seed_packing", label: "Phone charger and battery pack", pos: 2 },
    { id: "sit_seed_m1", listId: "lst_seed_maint", label: "Replace furnace filter", pos: 0 },
    { id: "sit_seed_m2", listId: "lst_seed_maint", label: "Clean gutters", assigned: partnerUserId, pos: 1 },
    { id: "sit_seed_m3", listId: "lst_seed_maint", label: "Drain and shut off exterior spigots before the first freeze", pos: 2 },
    { id: "sit_seed_gf1", listId: "lst_seed_gift", label: "Cast iron skillet for Mom", priv: true, pos: 0 },
    { id: "sit_seed_gf2", listId: "lst_seed_gift", label: "Noise-cancelling headphones for Jordan", priv: true, pos: 1 },
    { id: "sit_seed_s1", listId: "lst_seed_school", label: "24-pack #2 pencils", checked: true, pos: 0 },
    { id: "sit_seed_s2", listId: "lst_seed_school", label: "Composition notebooks (4)", pos: 1 },
    { id: "sit_seed_t1", listId: "lst_seed_tripprep", label: "Hold the mail", pos: 0 },
    { id: "sit_seed_t2", listId: "lst_seed_tripprep", label: "Arrange dog sitter", assigned: partnerUserId, pos: 1 },
    { id: "sit_seed_c1", listId: "lst_seed_custom", label: "Look into the community solar program", pos: 0 },
  ];
  await db
    .insert(schema.savedItems)
    .values(
      items.map((i) => ({
        id: i.id,
        listId: i.listId,
        createdByUserId: userId,
        label: i.label,
        checked: i.checked ?? false,
        checkedAt: i.checked ? day(-2) : null,
        checkedByUserId: i.checked ? userId : null,
        assignedToUserId: i.assigned ?? null,
        isPrivate: i.priv ?? false,
        position: i.pos,
      })),
    )
    .onConflictDoNothing();

  // ── Saved memories — all 12 categories ──────────────────────────────────────────────────────────
  // The Saved screen filters by category, so every memoryCategoryEnum value needs a row. Source kinds,
  // pinned/archived, ratings and tags are varied for the same reason.
  const memories = [
    { id: "mem_seed_product", cat: "product" as const, src: "link" as const, title: "Lodge 12-inch cast iron skillet", url: "https://example.com/lodge-skillet", rating: 5, pinned: true, tags: ["kitchen", "gift idea"] },
    { id: "mem_seed_place", cat: "place" as const, src: "place" as const, title: "Sunrise Cafe — Oak Park", url: null, rating: 4, tags: ["breakfast"] },
    { id: "mem_seed_recipe", cat: "recipe" as const, src: "recipe" as const, title: "Weeknight red lentil soup", url: "https://example.com/lentil-soup", rating: 5, tags: ["dinner", "vegetarian"] },
    { id: "mem_seed_article", cat: "article" as const, src: "link" as const, title: "How residential solar actually pays back", url: "https://example.com/solar", tags: ["home"] },
    { id: "mem_seed_movie", cat: "movie_show" as const, src: "link" as const, title: "Documentary series — recommended by Dana", url: null, tags: ["watchlist"] },
    { id: "mem_seed_gift", cat: "gift_idea" as const, src: "screenshot" as const, title: "Wool scarf Jordan kept looking at", url: null, tags: ["holiday"] },
    { id: "mem_seed_event", cat: "event" as const, src: "event" as const, title: "Oak Park farmers market — Saturdays through October", url: null, tags: ["local"] },
    { id: "mem_seed_trip", cat: "trip_idea" as const, src: "image" as const, title: "Cabin near Rocky Mountain National Park", url: null, rating: 4, tags: ["travel"] },
    { id: "mem_seed_howto", cat: "how_to" as const, src: "video" as const, title: "Replacing a kitchen faucet cartridge", url: "https://example.com/faucet", tags: ["repair"] },
    { id: "mem_seed_ref", cat: "reference" as const, src: "text" as const, title: "Furnace filter size — 20x25x1", url: null, tags: ["home"] },
    { id: "mem_seed_doc", cat: "document" as const, src: "document" as const, title: "Storage unit access code and hours", url: null, tags: ["storage"] },
    { id: "mem_seed_generic", cat: "generic" as const, src: "note" as const, title: "Ask the dentist about the night guard at the next cleaning", url: null, tags: [] },
  ];
  await db
    .insert(schema.savedMemories)
    .values(
      memories.map((m, idx) => ({
        id: m.id,
        ownerUserId: userId,
        sourceKind: m.src,
        sourceUrl: m.url,
        sourceDocumentId: m.cat === "document" ? "doc_seed_lease" : null,
        title: m.title,
        rawText: m.title,
        userNotes: idx % 3 === 0 ? "Saved from a link Jordan sent." : null,
        tags: m.tags,
        highlights: [],
        extractedFields: {},
        rating: m.rating ?? null,
        category: m.cat,
        categoryConfidence: 0.88,
        classificationState: "classified" as const,
        contentHash: `seed-mem-${m.id}`,
        pinned: m.pinned ?? false,
        createdAt: day(-idx - 1),
      })),
    )
    .onConflictDoNothing();

  // Archived and never-resurface rows: both are excluded from the default view, so without them the
  // "archived" filter and the resurfacing opt-out have nothing behind them.
  await db
    .insert(schema.savedMemories)
    .values([
      { id: "mem_seed_archived", ownerUserId: userId, sourceKind: "link", title: "Old apartment listing", category: "reference", classificationState: "classified", contentHash: "seed-mem-archived", archivedAt: day(-40), tags: [], highlights: [], extractedFields: {} },
      { id: "mem_seed_neverresurface", ownerUserId: userId, sourceKind: "note", title: "Draft note I do not want resurfaced", category: "generic", classificationState: "classified", contentHash: "seed-mem-never", neverResurface: true, tags: [], highlights: [], extractedFields: {} },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.resurfacingRules)
    .values({
      id: "rsr_seed_gift",
      ownerUserId: userId,
      savedMemoryId: "mem_seed_gift",
      triggerType: "person_birthday",
      triggerConfig: { personId: "per_seed_jordan" },
      active: true,
    })
    .onConflictDoNothing();

  // ── Trips — all 4 segment kinds, plus a past and an upcoming trip ───────────────────────────────
  await db
    .insert(schema.trips)
    .values([
      { id: "trp_seed_denver", ownerUserId: userId, householdId, label: "Denver — fall hiking", destinationLabel: "Denver, CO", startDate: onDate(41), startDateSort: day(41), endDate: onDate(45), endDateSort: day(45), status: "upcoming", travelerUserIds: [userId, partnerUserId], visibility: "household", packingListId: "lst_seed_packing" },
      { id: "trp_seed_madison", ownerUserId: userId, householdId, label: "Madison — Mom's birthday", destinationLabel: "Madison, WI", startDate: onDate(-60), startDateSort: day(-60), endDate: onDate(-57), endDateSort: day(-57), status: "past", travelerUserIds: [userId], visibility: "household" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.tripSegments)
    .values([
      { id: "seg_seed_flight", tripId: "trp_seed_denver", ownerUserId: userId, kind: "flight", providerName: "United Airlines", confirmationNumber: "UA7K2Q9", locationLabel: "ORD → DEN", startAt: atInstant(41), startAtSort: day(41), endAt: atInstant(41), endAtSort: day(41), detailsJson: { flightNumber: "UA 1287", seat: "14C" }, cancellationDeadline: onDate(34), cancellationDeadlineSort: day(34), status: "confirmed", confidenceBand: "verified", checkInReminderMinutesBefore: 1440 },
      { id: "seg_seed_lodging", tripId: "trp_seed_denver", ownerUserId: userId, kind: "lodging", providerName: "Cascade Inn", confirmationNumber: "CI-448120", locationLabel: "1900 Larimer St, Denver, CO", startAt: atInstant(41), startAtSort: day(41), endAt: atInstant(45), endAtSort: day(45), detailsJson: { roomType: "King, mountain view", nights: 4 }, cancellationDeadline: onDate(39), cancellationDeadlineSort: day(39), status: "confirmed", confidenceBand: "verified" },
      { id: "seg_seed_rental", tripId: "trp_seed_denver", ownerUserId: userId, kind: "rental", providerName: "Summit Car Rental", confirmationNumber: "SCR-99213", locationLabel: "Denver International Airport", startAt: atInstant(41), startAtSort: day(41), endAt: atInstant(45), endAtSort: day(45), detailsJson: { vehicleClass: "Midsize SUV" }, status: "confirmed", confidenceBand: "high" },
      // Disrupted on purpose: the disruption banner/state is otherwise unreachable with seeded data.
      { id: "seg_seed_ticket", tripId: "trp_seed_denver", ownerUserId: userId, kind: "ticket", providerName: "Red Rocks Amphitheatre", confirmationNumber: "RR-772311", locationLabel: "Morrison, CO", startAt: atInstant(43), startAtSort: day(43), detailsJson: { section: "GA" }, status: "confirmed", disruptionStatus: "schedule_changed", disruptionNote: "Start time moved 90 minutes later by the venue.", disruptionDetectedAt: day(-1), confidenceBand: "needs_review" },
      { id: "seg_seed_past_flight", tripId: "trp_seed_madison", ownerUserId: userId, kind: "flight", providerName: "Delta", confirmationNumber: "DL4M8X2", locationLabel: "ORD → MSN", startAt: atInstant(-60), startAtSort: day(-60), detailsJson: {}, status: "confirmed", confidenceBand: "verified" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.travelCredits)
    .values([
      { id: "tcr_seed_united", ownerUserId: userId, householdId, tripId: "trp_seed_madison", providerName: "United Airlines", amountMinorUnits: 24500, currency: "USD", expirationDate: onDate(120), expirationDateSort: day(120), redeemed: false, confidenceBand: "verified" },
      { id: "tcr_seed_redeemed", ownerUserId: userId, householdId, providerName: "Delta", amountMinorUnits: 8900, currency: "USD", expirationDate: onDate(-5), expirationDateSort: day(-5), redeemed: true, redeemedAt: day(-30), confidenceBand: "high" },
    ])
    .onConflictDoNothing();

  // ── People, organizations, relationships, notes, important dates ────────────────────────────────
  await db
    .insert(schema.organizations)
    .values([
      { id: "org_seed_dental", ownerUserId: userId, householdId, name: "Riverside Dental", organizationType: "healthcare" },
      { id: "org_seed_school", ownerUserId: userId, householdId, name: "Lincoln Elementary", organizationType: "school" },
    ])
    .onConflictDoNothing();

  const people = [
    { id: "per_seed_jordan", name: "Jordan Rivera", rel: "spouse_partner", important: true, org: null },
    { id: "per_seed_maya", name: "Maya Rivera", rel: "child", important: true, org: "org_seed_school" },
    { id: "per_seed_mom", name: "Carol Rivera", rel: "parent", important: true, org: null },
    { id: "per_seed_patel", name: "Dr. Anita Patel", rel: "dentist", important: false, org: "org_seed_dental" },
    { id: "per_seed_ruiz", name: "Ms. Ruiz", rel: "teacher", important: false, org: "org_seed_school" },
    { id: "per_seed_plumber", name: "Tomasz Wojcik — Northside Plumbing & Drain", rel: "plumber", important: false, org: null },
    { id: "per_seed_dana", name: "Dana Whitfield", rel: "friend", important: false, org: null },
  ];
  await db
    .insert(schema.people)
    .values(
      people.map((p) => ({
        id: p.id,
        ownerUserId: userId,
        householdId,
        displayName: p.name,
        organizationId: p.org,
        relationshipLabel: p.rel,
        isImportant: p.important,
        lastContactAt: day(-7),
        visibility: "household" as const,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(schema.aliases)
    .values([
      { id: "als_seed_jordan_email", personId: "per_seed_jordan", ownerUserId: userId, kind: "email", value: "jordan@example.com" },
      { id: "als_seed_mom_phone", personId: "per_seed_mom", ownerUserId: userId, kind: "phone", value: "+1-608-555-0142" },
      { id: "als_seed_patel_name", personId: "per_seed_patel", ownerUserId: userId, kind: "name_variant", value: "Anita Patel DDS" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.contactSources)
    .values({ id: "cts_seed_jordan", personId: "per_seed_jordan", ownerUserId: userId, provider: "gmail", connectionId: "conn_demo_gmail", providerContactId: "gmail-contact-1", syncedAt: day(-2) })
    .onConflictDoNothing();

  await db
    .insert(schema.personRelationships)
    .values([
      { id: "prl_seed_1", ownerUserId: userId, fromPersonId: "per_seed_jordan", toPersonId: "per_seed_maya", label: "parent of" },
      { id: "prl_seed_2", ownerUserId: userId, fromPersonId: "per_seed_maya", toPersonId: "per_seed_ruiz", label: "teacher" },
      { id: "prl_seed_3", ownerUserId: userId, fromPersonId: "per_seed_mom", toPersonId: "per_seed_jordan", label: "mother-in-law" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.personNotes)
    .values([
      { id: "pnt_seed_1", personId: "per_seed_patel", ownerUserId: userId, authorUserId: userId, body: "Prefers morning appointments. Ask about the night guard at the next cleaning." },
      { id: "pnt_seed_2", personId: "per_seed_mom", ownerUserId: userId, authorUserId: userId, body: "Allergic to penicillin — noted on her emergency card." },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.personImportantDates)
    .values([
      { id: "pid_seed_mom_bday", personId: "per_seed_mom", ownerUserId: userId, label: "Birthday", date: onDate(16), dateSort: day(16), reminderDaysBefore: 14 },
      { id: "pid_seed_anniversary", personId: "per_seed_jordan", ownerUserId: userId, label: "Anniversary", date: onDate(88), dateSort: day(88), reminderDaysBefore: 21 },
      { id: "pid_seed_maya_bday", personId: "per_seed_maya", ownerUserId: userId, label: "Birthday", date: onDate(-20), dateSort: day(-20), reminderDaysBefore: 14 },
    ])
    .onConflictDoNothing();

  // ── Pets ────────────────────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.petProfiles)
    .values([
      { id: "pet_seed_dog", ownerUserId: userId, householdId, label: "Biscuit", species: "dog", breed: "Labrador mix", birthDate: onDate(-1600), microchipNumber: "985112004553201", vetProviderName: "Riverside Animal Hospital", insuranceProviderName: "Trupanion", insurancePolicyNumber: "TP-88213", lifecycleStatus: "active" },
      { id: "pet_seed_cat", ownerUserId: userId, householdId, label: "Marmalade", species: "cat", breed: "Domestic shorthair", birthDate: onDate(-900), vetProviderName: "Riverside Animal Hospital", lifecycleStatus: "active" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.petVaccinations)
    .values([
      { id: "pvx_seed_rabies", ownerUserId: userId, householdId, petProfileId: "pet_seed_dog", label: "Rabies", expirationDate: onDate(150), expirationDateSort: day(150), source: "user_confirmed", confidenceBand: "verified" },
      // Already expired — the overdue state is otherwise unreachable.
      { id: "pvx_seed_license", ownerUserId: userId, householdId, petProfileId: "pet_seed_dog", label: "City dog license", expirationDate: onDate(-8), expirationDateSort: day(-8), source: "user_confirmed", confidenceBand: "verified" },
      { id: "pvx_seed_fvrcp", ownerUserId: userId, householdId, petProfileId: "pet_seed_cat", label: "FVRCP", expirationDate: onDate(60), expirationDateSort: day(60), source: "user_confirmed", confidenceBand: "high" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.refillReminders)
    .values({ id: "rfl_seed_flea", ownerUserId: userId, householdId, petProfileId: "pet_seed_dog", medicationName: "Flea and tick preventative", nextRefillDate: onDate(9), nextRefillDateSort: day(9), pharmacy: "Riverside Animal Hospital" })
    .onConflictDoNothing();

  // ── Properties and home assets ──────────────────────────────────────────────────────────────────
  await db
    .insert(schema.propertyProfiles)
    .values([
      { id: "prp_seed_home", ownerUserId: userId, householdId, label: "Home", propertyType: "home", address: "1428 Elmwood Ave, Oak Park, IL 60302", moveInDate: onDate(-1500) },
      { id: "prp_seed_cabin", ownerUserId: userId, householdId, label: "Lake cabin", propertyType: "vacation", address: "N7742 County Rd K, Eagle River, WI 54521", moveInDate: onDate(-700) },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.homeAssets)
    .values([
      { id: "hma_seed_furnace", ownerUserId: userId, propertyProfileId: "prp_seed_home", label: "Furnace", category: "hvac", room: "Basement", make: "Carrier", model: "59SC5A", serial: "CR-4417822", installDate: onDate(-1200) },
      { id: "hma_seed_fridge", ownerUserId: userId, propertyProfileId: "prp_seed_home", label: "Kitchen refrigerator", category: "appliance", room: "Kitchen", make: "LG", model: "LRFVS3006S", serial: "LG-99120att", installDate: onDate(-400) },
      { id: "hma_seed_heater", ownerUserId: userId, propertyProfileId: "prp_seed_home", label: "Water heater", category: "plumbing", room: "Basement", make: "Rheem", model: "XE50T10", installDate: onDate(-2100) },
    ])
    .onConflictDoNothing();

  // ── Vehicles ────────────────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.vehicleProfiles)
    .values([
      { id: "veh_seed_outback", ownerUserId: userId, householdId, label: "The Subaru", make: "Subaru", model: "Outback", year: 2019, vin: "4S4BSANC5K3300000", purchaseDate: onDate(-1100) },
      { id: "veh_seed_civic", ownerUserId: userId, householdId, label: "Jordan's Civic", make: "Honda", model: "Civic", year: 2015, vin: "19XFB2F59FE000000", purchaseDate: onDate(-2400) },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.odometerObservations)
    .values([
      { id: "odo_seed_1", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", mileage: 68_400, observedAt: onDate(-90), observedAtSort: day(-90), source: "user_entered", confidenceBand: "verified" },
      { id: "odo_seed_2", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", mileage: 71_250, observedAt: onDate(-5), observedAtSort: day(-5), source: "user_entered", confidenceBand: "verified" },
      { id: "odo_seed_3", ownerUserId: userId, vehicleProfileId: "veh_seed_civic", mileage: 132_900, observedAt: onDate(-12), observedAtSort: day(-12), source: "user_entered", confidenceBand: "verified" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.tires)
    .values({ id: "tir_seed_outback", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", brand: "Michelin", model: "CrossClimate2", size: "225/65R17", installDate: onDate(-300), installMileage: 64_100, rotationHistory: [{ date: iso(day(-120)).slice(0, 10), mileage: 67_800 }], pressureSpecPsi: 33, warrantyMonths: 60, status: "active" })
    .onConflictDoNothing();

  await db
    .insert(schema.maintenanceRules)
    .values([
      { id: "mrl_seed_oil", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", label: "Oil change", intervalType: "calendar_or_mileage", intervalDays: 180, intervalMiles: 6000, baselineMileage: 68_400, lastPerformedDate: onDate(-90), lastPerformedDateSort: day(-90), source: "seeded_generic_guidance", confidenceNote: "General guidance, not your manufacturer's published schedule." },
      { id: "mrl_seed_filter", ownerUserId: userId, homeAssetId: "hma_seed_furnace", label: "HVAC filter", intervalType: "calendar", intervalDays: 90, lastPerformedDate: onDate(-100), lastPerformedDateSort: day(-100), source: "user_added" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.maintenanceRecords)
    .values([
      { id: "mrc_seed_oil", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", description: "Oil and filter change, tire rotation", serviceDate: onDate(-90), serviceDateSort: day(-90), costMinorUnits: 8940, costCurrency: "USD", confidenceBand: "verified" },
      { id: "mrc_seed_hvac", ownerUserId: userId, propertyProfileId: "prp_seed_home", description: "Annual furnace inspection and tune-up", serviceDate: onDate(-200), serviceDateSort: day(-200), costMinorUnits: 14900, costCurrency: "USD", confidenceBand: "verified" },
      { id: "mrc_seed_vet", ownerUserId: userId, petProfileId: "pet_seed_dog", description: "Annual wellness exam and bloodwork", serviceDate: onDate(-45), serviceDateSort: day(-45), costMinorUnits: 21500, costCurrency: "USD", confidenceBand: "verified" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.registrationRecords)
    .values([
      { id: "reg_seed_outback", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", recordType: "registration", jurisdiction: "US-IL", renewalDueDate: onDate(52), renewalDueDateSort: day(52), reminderLeadDays: 30, status: "active" },
      { id: "reg_seed_civic_emissions", ownerUserId: userId, vehicleProfileId: "veh_seed_civic", recordType: "emissions", jurisdiction: "US-IL", renewalDueDate: onDate(-15), renewalDueDateSort: day(-15), reminderLeadDays: 30, status: "expired" },
    ])
    .onConflictDoNothing();

  // Public agency recall text — not user data, so not encrypted (matches the column's own note).
  await db
    .insert(schema.recallMatches)
    .values({ id: "rcl_seed_outback", ownerUserId: userId, vehicleProfileId: "veh_seed_outback", source: "nhtsa", campaignNumber: "21V-123", component: "FORWARD COLLISION AVOIDANCE", summary: "Seeded example recall record used to exercise the recall list and detail views.", remedy: "Dealer will update the software, free of charge.", url: "https://www.nhtsa.gov/recalls", matchedMake: "Subaru", matchedModel: "Outback", matchedYear: 2019, status: "potential_match_verify_vin", reportedDate: onDate(-500) })
    .onConflictDoNothing();

  // ── Identity records ────────────────────────────────────────────────────────────────────────────
  // Expiring-soon, far-future and already-expired are all present: the renewal reminder and the expired
  // badge are each unreachable without a row in that state.
  await db
    .insert(schema.identityRecords)
    .values([
      { id: "idr_seed_passport", ownerUserId: userId, householdId, recordType: "passport", label: "US Passport", issuingAuthority: "U.S. Department of State", documentNumber: "X12345678", issuedDate: onDate(-2000), expirationDate: onDate(400), expirationDateSort: day(400), linkedDocumentId: "doc_seed_passport", jurisdiction: "US", reminderLeadDays: 180, status: "active" },
      { id: "idr_seed_license", ownerUserId: userId, householdId, recordType: "drivers_license", label: "Illinois Driver's License", issuingAuthority: "Illinois Secretary of State", documentNumber: "R500-1234-5678", expirationDate: onDate(120), expirationDateSort: day(120), linkedDocumentId: "doc_seed_license", jurisdiction: "US-IL", reminderLeadDays: 60, status: "active" },
      { id: "idr_seed_registration", ownerUserId: userId, householdId, recordType: "vehicle_registration", label: "Subaru Outback registration", issuingAuthority: "Illinois Secretary of State", expirationDate: onDate(52), expirationDateSort: day(52), linkedVehicleId: "veh_seed_outback", jurisdiction: "US-IL", reminderLeadDays: 30, status: "active" },
      { id: "idr_seed_expired", ownerUserId: userId, householdId, recordType: "inspection", label: "Civic emissions test", issuingAuthority: "Illinois EPA", expirationDate: onDate(-15), expirationDateSort: day(-15), linkedVehicleId: "veh_seed_civic", jurisdiction: "US-IL", status: "expired" },
    ])
    .onConflictDoNothing();

  // ── Health appointments ─────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.healthAppointments)
    .values([
      { id: "hap_seed_dentist", ownerUserId: userId, householdId, visibility: "household", providerName: "Dr. Anita Patel — Riverside Dental", appointmentType: "Cleaning", dateTime: atInstant(12), dateTimeSort: day(12), location: "Riverside Dental, Oak Park", prepInstructions: "Bring the updated insurance card.", status: "confirmed", source: "manual", confidenceBand: "verified" },
      { id: "hap_seed_physical", ownerUserId: userId, householdId, visibility: "private", providerName: "Dr. Lewis Okafor", appointmentType: "Annual physical", dateTime: atInstant(30), dateTimeSort: day(30), location: "Oak Park Family Medicine", prepInstructions: "Fasting — nothing to eat or drink after midnight except water.", status: "confirmed", source: "manual", confidenceBand: "verified" },
      { id: "hap_seed_past", ownerUserId: userId, householdId, visibility: "household", providerName: "Riverside Dental", appointmentType: "Cleaning", dateTime: atInstant(-170), dateTimeSort: day(-170), location: "Riverside Dental, Oak Park", status: "completed", source: "manual", confidenceBand: "verified" },
    ])
    .onConflictDoNothing();

  // ── Tasks — every state and priority ────────────────────────────────────────────────────────────
  await db
    .insert(schema.tasks)
    .values([
      { id: "tsk_seed_overdue", ownerUserId: userId, householdId, title: "Renew the Civic's emissions test", dueCondition: onDate(-3), dueSort: day(-3), priority: "high", state: "open", consequence: "Registration cannot be renewed until this passes." },
      { id: "tsk_seed_today", ownerUserId: userId, householdId, title: "Call the pharmacy about Biscuit's refill", dueCondition: onDate(0), dueSort: day(0), priority: "medium", state: "open" },
      { id: "tsk_seed_soon", ownerUserId: userId, householdId, assignedToUserId: partnerUserId, assignmentStatus: "assigned", title: "Book the dog sitter for the Denver trip", dueCondition: onDate(7), dueSort: day(7), priority: "medium", state: "open", assignmentNotes: "Ask about the overnight rate." },
      { id: "tsk_seed_low", ownerUserId: userId, householdId, title: "Compare community solar providers", dueCondition: onDate(45), dueSort: day(45), priority: "low", state: "open" },
      { id: "tsk_seed_snoozed", ownerUserId: userId, householdId, title: "Schedule the gutter cleaning", dueCondition: onDate(3), dueSort: day(3), priority: "medium", state: "snoozed", snoozedUntil: day(5) },
      { id: "tsk_seed_done", ownerUserId: userId, householdId, title: "Replace the furnace filter", dueCondition: onDate(-10), dueSort: day(-10), priority: "medium", state: "completed" },
      { id: "tsk_seed_linked", ownerUserId: userId, householdId, title: "Bring the insurance card to the cleaning", dueCondition: onDate(12), dueSort: day(12), priority: "low", state: "open", healthAppointmentId: "hap_seed_dentist" },
    ])
    .onConflictDoNothing();

  // ── Sender rules — all 5 actions ────────────────────────────────────────────────────────────────
  await db
    .insert(schema.senderRules)
    .values([
      { id: "snr_seed_school", ownerUserId: userId, senderDomain: "lincolnelementary.org", action: "always_school" },
      { id: "snr_seed_bills", ownerUserId: userId, senderDomain: "citylightpower.com", action: "always_bills" },
      { id: "snr_seed_ignore", ownerUserId: userId, senderDomain: "marketing.example.com", action: "ignore" },
      { id: "snr_seed_attach", ownerUserId: userId, senderEmail: "statements@meridianmutual.com", action: "attachments_only" },
      { id: "snr_seed_shared", ownerUserId: userId, senderEmail: "office@riversidedental.com", action: "household_shared" },
    ])
    .onConflictDoNothing();

  // ── Canonical entities, facts, relationships ────────────────────────────────────────────────────
  await db
    .insert(schema.canonicalEntities)
    .values([
      { id: "ent_seed_subaru", type: "vehicle", ownerUserId: userId, householdId, displayLabel: "2019 Subaru Outback", aliases: ["The Subaru", "Outback"], lifecycleState: "active", visibility: "household" },
      { id: "ent_seed_home", type: "property", ownerUserId: userId, householdId, displayLabel: "1428 Elmwood Ave", aliases: ["Home"], lifecycleState: "active", visibility: "household" },
      { id: "ent_seed_biscuit", type: "pet", ownerUserId: userId, householdId, displayLabel: "Biscuit", aliases: [], lifecycleState: "active", visibility: "household" },
      { id: "ent_seed_netflix", type: "service", ownerUserId: userId, householdId, displayLabel: "Netflix", aliases: ["Netflix Premium"], lifecycleState: "active", visibility: "household" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.facts)
    .values([
      { id: "fct_seed_vin", subjectEntityId: "ent_seed_subaru", predicate: "vin", valueJson: "4S4BSANC5K3300000", extractionMethod: "user_entered", extractorVersion: "seed-1", confidenceScore: 1, confidenceBand: "verified", verification: "user_confirmed" },
      { id: "fct_seed_mileage", subjectEntityId: "ent_seed_subaru", predicate: "odometer_miles", valueJson: 71_250, unit: "mi", extractionMethod: "user_entered", extractorVersion: "seed-1", confidenceScore: 1, confidenceBand: "verified", verification: "user_confirmed" },
      { id: "fct_seed_filter", subjectEntityId: "ent_seed_home", predicate: "furnace_filter_size", valueJson: "20x25x1", extractionMethod: "user_entered", extractorVersion: "seed-1", confidenceScore: 0.9, confidenceBand: "high", verification: "unverified" },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.relationships)
    .values({ id: "rel_seed_pet_home", fromEntityId: "ent_seed_biscuit", toEntityId: "ent_seed_home", type: "lives_at", confidenceScore: 1 })
    .onConflictDoNothing();

  // ── Object notes ────────────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.objectNotes)
    .values([
      { id: "obn_seed_1", ownerUserId: userId, resourceType: "vehicle_profile", resourceId: "veh_seed_outback", noteText: "Rear wiper streaks — replace at the next oil change." },
      { id: "obn_seed_2", ownerUserId: userId, resourceType: "document", resourceId: "doc_seed_insurance", noteText: "Deductible went from $1,000 to $1,500 at this renewal." },
    ])
    .onConflictDoNothing();

  // ── Preferences ─────────────────────────────────────────────────────────────────────────────────
  await db
    .insert(schema.personalizationPreferences)
    .values({ userId, preferredName: "Alex", weekStart: "monday", timeFormat: "12h", askResponseStyle: "balanced", suggestionIntensity: "balanced", financialPrivacyModeEnabled: false })
    .onConflictDoNothing();

  await db
    .insert(schema.homeModulePreferences)
    .values({ userId, moduleOrder: ["attention", "today", "bills", "deliveries"], hiddenModules: [] })
    .onConflictDoNothing();

  // One disabled domain on purpose: with every category enabled, the disabled state of this toggle group
  // is never rendered, and neither is whatever the app does downstream when a domain is off.
  await db
    .insert(schema.categoryPreferences)
    .values(
      ["purchases", "bills", "subscriptions", "travel", "health", "school", "documents", "deliveries"].map((domain) => ({
        id: `cpr_seed_${domain}`,
        userId,
        domain,
        enabled: domain !== "school",
      })),
    )
    .onConflictDoNothing();

  // ── Sharing: legacy release + caregiver pass ────────────────────────────────────────────────────
  // Token/passcode hashes are placeholders: these rows exist so the sharing screens render real
  // configured state. They are NOT redeemable, which is the honest outcome — a working token would mean
  // seeding a credential that grants real access to the household.
  await db
    .insert(schema.legacyReleaseConfigs)
    .values({ id: "lrc_seed", ownerUserId: userId, householdId, trustedContactEmail: "carol@example.com", categories: ["documents", "identity", "insurance"], waitingPeriodDays: 14, inactivityThresholdDays: 90, status: "confirmed", confirmedAt: day(-60) })
    .onConflictDoNothing();

  await db
    .insert(schema.caregiverDayPasses)
    .values([
      { id: "cdp_seed_active", householdId, createdByUserId: userId, label: "Dog sitter — Denver trip", tokenHash: "seed-not-a-valid-token-active", scopes: ["pets", "emergency_binder"], startsAt: day(41), expiresAt: day(46) },
      { id: "cdp_seed_expired", householdId, createdByUserId: userId, label: "Babysitter — August", tokenHash: "seed-not-a-valid-token-expired", scopes: ["emergency_binder"], startsAt: day(-40), expiresAt: day(-38), expiredAt: day(-38) },
    ])
    .onConflictDoNothing();
}
