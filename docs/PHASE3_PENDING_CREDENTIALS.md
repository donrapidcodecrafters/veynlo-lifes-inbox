# Phase 3 — Items Needing Real Credentials, Money, or Partner Access

Same convention as `docs/PHASE2_PENDING_CREDENTIALS.md`: everything below is **code-complete** (built,
typechecked, tested where the feature has a real backend to test) and will activate the moment a real
value/partnership is supplied — no further engineering work needed for the pieces that are genuinely just
waiting on a credential. Some Phase 3 items below are explicitly **not** code-complete because the spec
itself says the underlying capability can't be built responsibly without a partner agreement that doesn't
exist in this environment (smart-home) — those are marked as such rather than papered over.

## Location & Context (§30, LOC-003/004/005)

- **Real, working today with zero external dependency**: saved places, geofences, arrival/departure
  context rules, discrete trigger-event recording, and the location-permission-state record. All of it
  runs on-device via `expo-location`'s OS-native geofencing (`Location.startGeofencingAsync`) — no paid
  API, no server-side tracking. See `packages/db/src/schema/location.ts`,
  `services/api/src/modules/location/`, and the mobile screens under `apps/mobile/app/places*`.
- **`MAPS_PROVIDER_API_KEY`** — **not configured, and LOC-004 (travel-time conflict) deliberately does not
  wait on it.** A real travel-time estimate (Google Distance Matrix API or an equivalent traffic-aware
  provider) needs a paid key that doesn't exist in this dev environment. Rather than block the feature or
  fabricate a fake provider response, `packages/core/src/util/geo.ts` computes a straight-line (haversine)
  estimate and returns it together with a mandatory, always-surfaced uncertainty disclosure ("Rough
  straight-line estimate, not real traffic-aware travel time..."). This satisfies spec LOC-004's own "Show
  estimate and uncertainty" requirement honestly — the estimate is real, the roughness is disclosed, never
  hidden — but it is NOT what a real Distance Matrix integration would produce (no traffic, no routing, no
  road network at all). **Action needed to upgrade this to a real traffic-aware estimate:** a Google Cloud
  project with the Distance Matrix API (or Directions API) enabled and billing configured, or an
  equivalent provider (Mapbox, HERE, etc.), plus wiring a new `MAPS_PROVIDER_API_KEY`-gated code path in
  `LocationService.estimateTravelTime` that calls it when the key is present and falls back to the
  haversine estimate otherwise (that fallback logic does not exist today — this is a real follow-up, not
  just dropping in a key).
- **Geocoding provider (none configured)** — LOC-005 "Place from capture" extracts a Place candidate from
  a maps-link URL with embedded coordinates, or from a plain street-address-shaped string, using pure
  regex parsing (`packages/core/src/util/place-extraction.ts`) — zero network calls. It deliberately does
  **not** resolve a bare business name ("Starbucks on 5th", "the DMV") to coordinates, and a plain street
  address extracted this way has an address string but no lat/lng until the user fills it in (or a
  geocoder resolves it) — a geofence cannot be created on a place with no coordinates
  (`PLACE_MISSING_COORDINATES`, enforced in `LocationService.createGeofence`/`estimateTravelTime`). **A
  real geocoding provider** (Google Geocoding API, Mapbox Geocoding, etc. — again needs its own paid
  account/API key) would let LOC-005 resolve both cases, plus support the spec's "Disambiguation asks user
  when multiple businesses/locations match" for a bare name, which today simply returns no candidate
  rather than guessing.
- **Native geofencing — needs a real device/prebuild to verify** (same class of gap as Phase 2's Plaid
  Link/share-intent entries in `docs/PHASE2_PENDING_CREDENTIALS.md`). `expo-location` +
  `expo-task-manager` were added as real dependencies and wired into `app.json`'s plugin list; the
  foreground/background/precise consent screens, `Location.startGeofencingAsync` registration, and the
  `TaskManager.defineTask` background handler are all real, typechecked code — not a stub — but this
  environment cannot run `expo prebuild` + Xcode/Gradle, so the actual "OS fires a geofence region while
  the app is backgrounded" behavior has never run on a real device. See
  `apps/mobile/src/lib/geofencing.native.ts`'s own doc comment for exactly what is and isn't verified.

## Saved Memory, Lists & Knowledge (§29.1, SAVE-001..007)

**Built and real, zero external dependency — no item below is waiting on a credential.** A prior audit
found three concrete gaps against spec; all three are now closed:

- **SAVE-004 "Contextual resurfacing" — all five trigger types are now live** (previously only
  `date`/`person_birthday`/`trip_location` existed). The two added:
  - **`location_proximity`** — reuses this app's real, already-working Location domain
    (`services/api/src/modules/location/`, `packages/db/src/schema/location.ts` — on-device OS geofencing,
    no paid maps/geocoding API; see this doc's own Location section above) rather than inventing a second
    location mechanism. A saved memory links to one of the owner's own saved `places` rows — either
    automatically, when `MemoriesService.processClassification` recognizes a maps-link/address in the saved
    content (`extractPlaceCandidate` + a haversine match against saved places, `MemoriesService.
    maybeCreateLocationProximityRule`) or a free-text location label substring-matches a saved place, or
    explicitly via `POST /v1/memories/:id/resurfacing-rules` — and fires the instant a real geofence arrival
    is reported, via `ResurfacingService.fireLocationProximityResurfacing`, called directly from
    `LocationService.recordGeofenceEvent`. Deliberately event-driven, not scan-tick-driven (there's nothing
    to poll between arrivals) — see `ResurfacingService`'s own doc comment.
  - **`query_based`** — "surface a saved memory that's relevant to what you're searching/asking, even
    though it wasn't itself a direct hit." Kept honest given this app's confirmed lack of real semantic
    search (the `search_documents` pgvector column is reserved but completely unwired): reuses the exact
    same lexical relevance-ranking `search.service.ts` already uses for structured search/Ask
    (`MemoriesService.relatedForQuery`), run as a secondary pass alongside a real search/Ask request — not
    a new independent trigger with a `resurfacing_rules` row of its own. Surfaced in the web Ask/Search page
    as a "You might also want to revisit…" strip.
- **SAVE-006 "tags, ratings, highlights"** — `saved_memories` gained `tags` (encrypted jsonb string array,
  same precedent as `documents.tags`), `rating` (nullable 1-5 integer, user-set only), and `highlights`
  (encrypted jsonb string array of free-text quoted passages). Full add/edit/remove UI on both platforms'
  saved-item detail pages. Same privacy discipline as `userNotes`: `MemoriesService.
  redactNotesForNonOwner` redacts all three identically — never visible to a resourceGrant recipient, and
  `publicShareContent`'s payload never selects them at all — verified by a real adversarial-access test
  (`memories.service.test.ts`, "stays private to a non-owner grant recipient"). A full arbitrary-schema
  "custom fields" concept (beyond these three concrete, spec-named cases) was deliberately not built —
  a genuine scope decision, not a gap waiting on anything.
- **SAVE-007 "auto-archive after a condition" — UI control added.** The backend field/scan
  (`savedMemories.autoArchiveAt`, `ResurfacingService.autoArchiveDueItems`) already worked correctly (a
  prior audit confirmed this with a live test) but had zero UI anywhere to actually set it. Both platforms'
  saved-item detail pages now have an "Archive automatically after…" control: relative quick-picks (7/30/90
  days) plus a specific-date option, PUT through the same `autoArchiveAtIso` field the backend already
  accepted.

See `services/api/src/modules/memories/`, `packages/db/src/schema/memories.ts`,
`apps/web/src/app/(app)/saved/[id]/page.tsx`, `apps/mobile/app/saved-item/[id].tsx`, and the real-Postgres
tests in `memories.service.test.ts`/`resurfacing.service.test.ts`/`location.service.test.ts`/
`search.domain-coverage.test.ts`.

## Smart Home & Connected Devices (§31, SMART-001/002/003)

**Not code-complete, on purpose — this is data model + adapter interface only, per spec's own scoping
("Smart-home integration is a later expansion... Direct integrations require explicit provider
capabilities").** Every vendor below needs its own OAuth app registration or partner API agreement before
a single line of adapter implementation can be written responsibly (an unverifiable "integration" against
a provider with no real API access would be indistinguishable from a fake one). Built so far:
`packages/db/src/schema/smart-home.ts` (`smartConnections`/`smartDevices`/`deviceSignals` tables, matching
`packages/db/src/schema/assets.ts`'s `vehicleProfiles`/`maintenanceRecords` conventions) and
`services/api/src/modules/smart-home/smart-home-adapter.interface.ts` (the `SmartHomeAdapter` interface,
mirroring `connector.interface.ts`'s `ConnectorAdapter`/`OAuthConnectorAdapter` shape) — zero concrete
classes implement it, and nothing in the app's UI presents any smart-home provider as connectable today
(the Connections page shows a "coming soon" note, not a working "Connect" button — see
`apps/web/src/app/(app)/connections/page.tsx`'s smart-home card and `apps/mobile/app/connections.tsx`'s
equivalent).

Per-provider requirements to make each one real:

- **Home Assistant** — no OAuth app registration needed (it's typically self-hosted), but needs a
  long-lived access token or OAuth flow against the specific instance a user runs, plus a decision on
  whether Veynlo supports Home Assistant Cloud's Nabu Casa remote-access layer or requires local network
  reachability from the API — a real product/architecture decision, not just a credential.
- **SmartThings** — a Samsung SmartThings developer account, a registered SmartApp/OAuth client, and
  approval for the specific device-capability scopes needed (locks, sensors, etc.).
- **Nest / Google Home ecosystem** — a Google Device Access Console project ($5 one-time registration fee
  per Google's own terms) plus the same `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` reused elsewhere in this app
  extended with Device Access scopes — Nest's API access model changed multiple times over the years and
  the current Device Access Console terms should be re-confirmed before building against them.
- **Alexa-compatible services** — an Amazon Login with Amazon (LWA) security profile plus a registered
  Alexa Smart Home Skill (or Works With Alexa partnership), which requires Amazon's own partner
  application/review process, not just an API key.
- **Ring** — Ring has no public partner API program at the time of writing (its API is used internally by
  Ring's own apps and a small set of named partners); would need a direct partnership with Ring/Amazon
  before any adapter could be built at all, real or otherwise.
- **Ecobee** — an Ecobee developer account and registered application (API key), plus Ecobee's own app
  approval process for anything beyond a personal/test app.
- **Philips Hue** — a Philips Hue developer account and registered application (client ID/secret) via the
  Hue remote API, or local-bridge-only integration (no cloud OAuth, but no remote/background access
  either) — a real product decision on which mode(s) to support.

SMART-002 ("maintenance/health signals into obligations") and SMART-003 ("home-event context") both depend
entirely on a first real adapter existing to produce signals in the first place — `SmartHomeAdapter.
fileSignalAsObligation`'s doc comment spells out exactly what a future adapter needs to call once one is
built; no generic "signal → obligation" filing code was written ahead of a real caller to exercise it
against, since untested code written for a hook nothing calls yet is exactly the kind of "looks real, never
actually runs" gap this doc exists to avoid introducing.

## School, Children & Activities (§25)

**Built and real, zero external dependency**: SCH-001 (school email/PDF domain extraction —
`IngestionService.extractSchool`, a new `"school"` classifier domain, `SchoolExtractionSchema`), SCH-002
(school/team ICS-feed subscribe/unsubscribe/resync — `SchoolIcsService`, reusing `SafeUrlFetcher`'s
SSRF-safe fetch path exactly like `IcsAdapter`, with a recurring `schoolSourceScan` worker tick), SCH-005
(sports/activity schedule — same `school_events` table, `kind: "game"/"practice"`, with participant/venue/
arrival-time/prep fields captured when the source states them), SCH-006 (permission/form tracking —
`permission_forms`, evidence-based `discovered → opened → completed → submitted → confirmed` state,
forward-only), and SCH-007 (evidence-backed prep tasks — a real linked `tasks` row per literally-stated
"bring/wear" instruction; an AI-generic suggestion is deliberately never persisted, only rendered
client-side and labeled "Suggested"). See `packages/db/src/schema/school.ts`,
`services/api/src/modules/school/`, and `IngestionService.extractSchool`/`ingestFeedSchoolEvent`. Gated
behind the existing `family_school_sharing` capability (`packages/core/src/entitlements/plans.ts` — already
false on free/plus, true on family/pro_agent; no new entitlement key was needed).

**SCH-003 (Learning platform connector — Canvas, Schoology, Google Classroom) and SCH-004 (Student
information system connector — PowerSchool, Infinite Campus) are explicitly spec'd as "Future" and are
correctly NOT built.** Spec's own language: SCH-003 "Future: ... official APIs where parent/student access
allows" and SCH-004 "Future: ... where official APIs/consent exist... not required for core Life Inbox."
Building either responsibly needs, at minimum:

- **Canvas** — a Canvas API developer key issued by the specific institution/district (Canvas's API is
  per-instance, not a single global OAuth app — a district's Canvas admin has to register the integration),
  plus a product decision on whether Veynlo pursues Canvas's official partner/LTI program or a more limited
  personal-access-token flow (weaker, user-provided, and against most districts' IT policy to hand out).
- **Schoology** — a registered Schoology API consumer key/secret via PowerSchool's (Schoology's parent
  company) developer portal, which requires a school/district's explicit administrative approval per
  Schoology's own terms — not a self-serve OAuth app a single family could set up.
- **Google Classroom** — reuses the existing `GOOGLE_OAUTH_CLIENT_ID`/`SECRET` mechanically, but needs the
  Classroom-specific scopes added to that OAuth consent screen and, per spec's own explicit caution ("must
  not promise unsupported guardian access"), a real product decision on what a *guardian* (as opposed to
  the student themself) can actually see via Classroom's Guardian API — which is deliberately limited to
  summary email digests, not full assignment access, by Google's own design. Building this without that
  decision risks exactly the overpromise the spec warns against.
- **PowerSchool / Infinite Campus (SIS)** — both require a district-level API agreement (PowerSchool's
  Plugin/API program, Infinite Campus's Campus Data Access Portal), typically with a signed data-sharing
  agreement between the vendor, the district, and Veynlo — not obtainable by an individual family/user, and
  gated on grades/attendance data sensitivity that spec explicitly calls out as needing to be "a separate
  explicit feature" with its own consent, not bundled into core Life Inbox.

None of these four blocks anything else in §25 — every other SCH-* item (001/002/005/006/007) works fully
today through email/PDF/ICS, which spec's own §25.1 "Ingestion strategy" states is the intended
launch-first path precisely because school systems are this fragmented.

## Travel & Reservations (§26, TRIP-001..009)

**Built and real, zero external dependency**: TRIP-001 trip auto-clustering (`TripsService.clusterSegment`
— precision-first: a new segment auto-attaches to an existing trip only on an unambiguous single
date+destination match; an ambiguous or zero match creates a new trip, with ambiguous candidates recorded
on `trips.suggestedMergeTripIds` for the user to resolve via the explicit `POST /v1/trips/:id/merge`, never
auto-merged) and the TRIP-001 manual-seed fallback (`TripsService.createManualTrip`); TRIP-002..005
flight/lodging/rental/ticket extraction (`IngestionService.extractTripSegment`,
`TripSegmentExtractionSchema` — one polymorphic `trip_segments` table with a `kind` discriminator, see
`packages/db/src/schema/travel.ts`'s module doc comment for why, mirroring how `calendarEvents`/`purchases`
already model this); TRIP-006 travel document readiness (`documents.documentKind`/`expiresAt` — a minimal
addition to the existing Documents vault rather than a new identity-document subsystem, compared against
upcoming trip dates in both `TripsService.tripDetail` and `AttentionService.scanAndFileDeadlines`'s
`travelDocuments` scan — **never** invents a visa/entry-validity rule, only ever "verify entry requirements
for your destination yourself," per spec's own explicit instruction); TRIP-007 credit/voucher tracking (a
dedicated `travel_credits` table — see its own schema doc comment for why it's not just reusing
`storeCredits` — with the same expiration-alert pattern `scanAndFileDeadlines` already applies to
`storeCredits`/`warranties`); TRIP-008 packing lists (auto-created via the existing `Lists`/`savedItems`
feature, `trips.packingListId`, starter items explicitly prefixed `"Suggested:"` — never presented as
fact); and TRIP-009 disruption mode as a notification-only elevation (a CAL-004-style reschedule
reconciliation: a second email about an already-clustered segment that explicitly states a
cancellation/delay, or materially changes the schedule, sets `tripSegments.disruptionStatus` and surfaces a
banner in the web/mobile trip detail view — no rebooking action of any kind). Gated behind a new
`travel_planning` capability (`packages/core/src/entitlements/plans.ts` — false on free, true on
plus/family/pro_agent, matching spec's "Entitlement: Plus"). See `packages/db/src/schema/travel.ts`,
`services/api/src/modules/trips/`, `IngestionService.extractTripSegment`, and
`apps/web/src/app/(app)/trips/`, `apps/mobile/app/trips.tsx` / `apps/mobile/app/trip/[id].tsx`.

**Also built, zero external dependency (closing a spec-retraceability audit's gap list) — every one of
these is a real, tested action, not documentation-only:**

- **"Open confirmation" segment action** — `TripsService.segmentEvidence`
  (`GET /v1/trips/segments/:segmentId/evidence`) resolves a segment's own `sourceEventId` column straight to
  its source email's subject/snippet/sender/date, the same evidence-resolution shape as
  `ScheduleService.evidenceForSourceEvent` (simpler here — `trip_segments` has a direct `sourceEventId`
  column, unlike `calendar_events`' indirect inbox-item lookup). Rendered via the shared `EvidenceCard`
  component on both web and mobile, toggled open per segment card.
- **"Add calendar" segment action** — `TripsService.addSegmentToCalendar`
  (`POST /v1/trips/segments/:segmentId/calendar`) reuses `ScheduleService.createEvent` to create a REAL
  `calendar_events` row (title derived from kind + provider, e.g. "Flight — United"; the segment's own
  start/end carried over untouched), the identical event-creation path every other add-to-calendar action in
  this app goes through. A segment with no resolvable date is rejected (`NO_SEGMENT_DATE`) rather than
  silently creating an undated event.
- **"Set check-in reminder" segment action (TRIP-002/003)** — a new plain integer column,
  `tripSegments.checkInReminderMinutesBefore` (not encrypted, not folded into `detailsJson`, so
  `AttentionService.scanAndFileDeadlines` can scan it directly — mirrors `calendarEvents.reminderMinutesBefore`'s
  own shape). Deliberately its own field rather than requiring a real calendar event to exist first: a trip
  segment doesn't get a `calendar_events` row unless the user explicitly uses "Add calendar" above, and the
  check-in reminder needs to work independent of that. Flight/lodging only (`TripsService.
  setSegmentCheckInReminder` rejects rental/ticket with `NOT_CHECK_IN_ELIGIBLE`); wired into a new
  `scanAndFileDeadlines` scan (reasonCode `trip_check_in_reminder`) that fires once the lead time is reached,
  the same "not yet due — a later tick will pick it up" shape as the existing CAL-002 `event_reminder` scan.
- **TRIP-002 `baggageInfo` / TRIP-003 `feesInfo`** — free-text fields added to
  `TripSegmentExtractionSchema` and stored in `tripSegments.detailsJson` (same "common fields are real
  columns, kind-specific fields live in `detailsJson`" convention every other field on this table already
  follows), populated ONLY when the source email literally states a baggage allowance or a fee — the system
  prompt and the extraction write path both enforce "never infer from the airline/property's general
  policy," matching this codebase's "never invent a fact not literally in the source" discipline everywhere
  else. Shown on the flight/lodging segment card respectively, on both web and mobile.
- **TRIP-002 "last confirmed" freshness label** — a plain "Last confirmed: [date]" line on flight segment
  cards, reading `tripSegments.updatedAt` (the last time this segment was written — either its original
  extraction or a later reconciliation). This satisfies spec's "email-only mode labels last confirmed
  information and freshness" clause specifically; the live-status-feed half of that same spec line is still
  deferred (see below) — there is still no live feed this label could otherwise be sourced from.
- **TRIP-005 ticket/booking deep-link** — `bookingUrl`, another free-text `detailsJson` field, added to
  `TripSegmentExtractionSchema` and populated only when the source email contains a real "manage your
  booking" / "view your ticket" link. Rendered as a "View on [provider]" deep-link-out (provider label
  derived from the URL's own hostname) on both web and mobile — deliberately NOT an attempted
  barcode/ticket-image render, which spec's "respect provider terms" line rules out as unsafe/unlicensed to
  fabricate.
- **TRIP-004 rental-return alert** — confirmed gap closed: nothing previously scanned `trip_segments` for a
  rental/ground-transport return deadline at all. No new column needed — a rental segment's own
  `endAt`/`endAtSort` (common to every segment kind) already IS the return/dropoff time; a new
  `scanAndFileDeadlines` scan (reasonCode `rental_return_due`) reads it directly, using
  `detailsJson.dropoffLocation` (falling back to the segment's general `locationLabel`) for the return
  location, and excludes a cancelled reservation.

See `services/api/src/modules/trips/trips.service.ts` (`segmentEvidence`/`addSegmentToCalendar`/
`setSegmentCheckInReminder`), `services/api/src/modules/attention/attention.service.ts`'s
`scanAndFileDeadlines` (the `checkInCandidates`/`rentalReturnCandidates` blocks), and the segment-card UI on
both `apps/web/src/app/(app)/trips/[id]/page.tsx` and `apps/mobile/app/trip/[id].tsx`. Real-Postgres
regression coverage: `services/api/src/modules/trips/trips.segment-actions.test.ts`,
`services/api/src/modules/attention/attention.trip-segment-actions.test.ts`, and the extended
`services/api/src/modules/ingestion/ingestion.trip-segment.test.ts`.

**Deliberately deferred — needs a real data/API provider, not just engineering time:**

- **Weather-dependent packing suggestions (TRIP-008)** — spec: "weather-dependent suggestions require
  current data at time of use." This dev environment has no live weather API configured (no
  `WEATHER_PROVIDER_API_KEY` or equivalent exists anywhere in this codebase). `TripsService.ensurePackingList`
  seeds only generic, non-weather-dependent starter items (passport/ID, phone charger, toiletries,
  medications) for exactly this reason — a real integration (OpenWeatherMap, Weatherkit, NOAA, etc., each
  needing its own account/API key) would let a future version add "pack a rain jacket" for a rainy
  forecast, gated on the trip's destination + date being close enough for a real forecast to exist.
- **Real flight/lodging/rental live-status feeds (TRIP-002/009)** — spec: "Status updates come only from
  reliable feed/airline/partner source; email-only mode labels last confirmed information and freshness"
  and "Optional status providers are separate adapters." The "labels last confirmed information and
  freshness" half of that line is now built (the flight segment card's own "Last confirmed: [date]" label —
  see above); what's still deferred is the live-feed half. No airline/GDS/FlightAware-style status API is
  configured in this environment. TRIP-009's disruption mode today is honestly scoped to what's actually
  available without one: a reschedule/cancellation confirmation EMAIL arriving for an already-clustered
  segment (see `TripsService.reconcileSegment`) — this is real, tested, and matches the spec's own
  email-only-mode allowance, but it is NOT a live status feed; a segment that's actually delayed with no
  follow-up email (the airline updates its app/website but never emails) will not be caught. Wiring a real
  feed needs its own adapter interface (mirroring `SmartHomeAdapter`'s shape above) plus a paid
  data-provider account per airline/GDS integrated.
- **Real rebooking (TRIP-009)** — spec is explicit: "Future agent can prepare rebooking options only
  through authorized commercial APIs/partners." Correctly out of scope entirely — this app never attempts
  to search for, hold, or book an alternative flight/hotel/rental on the user's behalf; the disruption
  banner's only actions are "view confirmation" and "contact info," pointing the user to the provider
  directly. Building real rebooking would need a commercial travel-API partnership (e.g. a GDS/NDC
  aggregator, or direct airline/hotel partner APIs) — a business relationship, not a credential to drop in.
- **Jurisdiction-specific visa/entry-rule data (TRIP-006)** — spec is explicit: "Life Inbox does not invent
  visa/validity requirements; official travel-rule data partner needed for automatic jurisdiction
  guidance." No such partner (e.g. a visa-requirement API/database) is integrated, and none should be
  fabricated — TRIP-006's passport-expiry check deliberately only ever says "verify entry requirements for
  your destination," never a specific rule for a specific country.

## Family Transport Conflicts (school-relevant slice of CAL-003, tied to §25) — now built

**Built**: `ConflictService.schoolTransportConflicts` flags when two DIFFERENT dependents each have a
school/activity event requiring drop-off/pickup (`school_events.requiresDropoff`/`requiresPickup`, set for
game/practice/field_trip kinds with a specific time) within an overlapping or same-day window, in the same
household — AND now actually checks whether an available adult driver exists, closing the gap this doc
previously called "a real product feature to design and build."

The adult-availability model this needed didn't exist anywhere in the codebase before this pass; it's real
now: `HouseholdService.activeAdultUserIds` (every active `household_owner`/`adult_member` in a household) +
`householdAdultBusyIntervals` (services/api/src/modules/schedule/adult-availability.ts) aggregate each adult's
OWN `calendar_events` — including their private ones, since an adult's own calendar determines their real
availability regardless of what they've shared with the household — into busy intervals. Privacy discipline
(spec CAL-001: "Household availability may expose 'busy' without exposing private event title/details"):
the function's SQL only ever selects `start`/`end`/`isAllDay`/`ownerUserId`, never `title` or `location`, so
no event content can leak structurally, let alone in practice — verified adversarially in
`adult-availability.test.ts` (a planted, distinctively-named private event's title is asserted absent from
the returned data, from a serialized dump, and from every interval's own key set) and again end-to-end in
`school.test.ts` and via a live Playwright run against the real dev app (a private "confidential" calendar
event never appears in the `/v1/school/conflicts` response or the Life page's conflict banner, only the
busy/free fact it produced).

For each detected two-dependent transport-conflict pair, `schoolTransportConflicts` now checks whether at
least one adult is free during EACH event's own drop-off/pickup window. If so, the conflict is recorded with
`severity: "standard"` (two kids need rides, but someone's realistically available for each — the web/mobile
Life page shows this as its original amber wording). If NO adult is free for one or both windows, it's
recorded with `severity: "elevated"` and `unavailableEventIds` naming which event(s) have nobody free — the
UI shows this in bold red as "No available adult for [event] — everyone in the household looks busy then."
The stored row is refreshed (not just computed once) every time the check re-runs, so a later change to an
adult's calendar is reflected the next time an involved school event is saved.

Honestly documented as a best-effort heuristic, not a scheduling guarantee (see `schoolTransportConflicts`'
and `householdAdultBusyIntervals`'s own doc comments): an adult "free" per their calendar might still be
unavailable for reasons no calendar entry captures (no license, out of gas, at a desk job with nothing
blocked off for it), and one who's calendar-idle-but-actually-busy will still read as free. It also doesn't
require the free adult(s) to be two DIFFERENT people when both windows overlap in time — that finer
distinction would need real per-adult commitment tracking this app has no concept of. This surfaces a real,
more urgent case earlier than never checking at all; it can't promise a driver actually shows up.
