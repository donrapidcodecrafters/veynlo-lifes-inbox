/**
 * Opaque, prefixed resource IDs (spec §42.1: "never expose database sequence
 * IDs as authorization assumptions"). Prefixes make IDs self-describing in
 * logs, URLs, and support tooling without a lookup.
 */
export const ID_PREFIXES = {
  user: "usr",
  household: "hh",
  membership: "mem",
  identityLink: "idl",
  dependentProfile: "dep",
  caregiverDelegation: "cgd",
  connection: "conn",
  credential: "cred",
  sourceEvent: "src",
  evidence: "evd",
  fact: "fact",
  entity: "ent",
  relationship: "rel",
  document: "doc",
  documentVersion: "docv",
  inboxItem: "inb",
  attentionItem: "att",
  notification: "ntf",
  merchant: "mer",
  merchantMergeLineage: "mml",
  purchase: "pur",
  purchaseLine: "purl",
  returnCase: "ret",
  shipment: "shp",
  subscription: "sub",
  bill: "bil",
  warranty: "war",
  recurringStream: "rec",
  calendarEvent: "evt",
  task: "tsk",
  trip: "trip",
  place: "plc",
  person: "per",
  organization: "org",
  savedItem: "sav",
  list: "lst",
  savedMemory: "svm",
  resurfacingRule: "rsr",
  automationRule: "rule",
  automationRun: "run",
  resourceGrant: "grn",
  shareLink: "shl",
  plan: "plan",
  entitlement: "ent2",
  billingEvent: "bev",
  auditEvent: "aud",
  exportJob: "exp",
  session: "sess",
  device: "dev",
  passwordResetToken: "prt",
  job: "job",
  adminUser: "adm",
  adminSession: "adms",
  signupInvite: "sinv",
  extractorVersion: "exv",
  extractionRun: "exr",
  property: "prop",
  vehicle: "veh",
  maintenanceRecord: "maint",
  storeCredit: "sc",
  financialAccount: "facct",
  financialTransaction: "ftxn",
  priceObservation: "price",
  scheduleConflict: "conflict",
  school: "sch",
  schoolSource: "schsrc",
  schoolEvent: "schev",
  permissionForm: "pform",
  tripSegment: "tseg",
  travelCredit: "tcr",
  pet: "pet",
  petVaccination: "petvax",
  refillReminder: "refill",
  // Phase 3 §30 Location & Context (LOC-003/004/005). `place` above already covers the Place row itself.
  geofence: "geo",
  contextRule: "ctxr",
  geofenceEvent: "gfe",
  travelEstimate: "trvl",
  // Phase 3 §31 Smart Home & Connected Devices (SMART-001/002) — data model only, see
  // packages/db/src/schema/smart-home.ts's doc comment.
  smartConnection: "smc",
  smartDevice: "sdv",
  deviceSignal: "dsig",
  // Phase 3 VEH-006/VEH-007/HOMEOS-008 — recall monitoring, odometer/tire tracking, home-asset warranty/
  // recall linkage. See packages/db/src/schema/assets.ts's doc comments on each table.
  odometerObservation: "odo",
  tire: "tire",
  homeAsset: "hasset",
  recallMatch: "recall",
  // §27 Health Logistics (Non-Diagnostic) — HLTH-001. refillReminder above already covers HLTH-003 (shared
  // with pets — see packages/db/src/schema/assets.ts's own doc comment on that table).
  healthAppointment: "hap",
  // CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — see
  // packages/db/src/schema/calendar-reschedule.ts's doc comments on both tables.
  calendarRescheduleTrustedRule: "crtr",
  calendarRescheduleProposal: "crp",
  // RET-004 "Policy engine stores sourced retailer terms with effective dates" — see
  // packages/db/src/schema/commerce.ts's merchantPriceAdjustmentPolicies doc comment.
  merchantPriceAdjustmentPolicy: "mpap",
  // SUB-004 "Cancellation assistant ... shows known steps" — see packages/db/src/schema/commerce.ts's
  // merchantCancellationSteps doc comment.
  merchantCancellationStep: "mcs",
  // §14 Contacts, People & Relationships (PEO-001..005) — see packages/db/src/schema/people.ts's doc
  // comments. `person`/`organization`/`relationship` above were already reserved but unused until now.
  personMergeLineage: "pml",
  contactSource: "csrc",
  alias: "alias",
  personRelationship: "prel",
  personNote: "pnote",
  personImportantDate: "pdate",
  // PERS-003 "Category preferences" — see packages/db/src/schema/preferences.ts's categoryPreferences
  // doc comment.
  categoryPreference: "catpref",
  // AUTH-001 "create passkey" — see packages/db/src/schema/identity.ts's passkeyCredentials doc comment.
  passkeyCredential: "pky",
  // Onboarding flow state — see services/api/src/modules/onboarding/onboarding.service.ts and
  // packages/db/src/schema/onboarding.ts's onboardingState table.
  onboardingState: "obs",
  // "Identity & Legal Continuity" (ID-001..005) — see packages/db/src/schema/identity-records.ts's own doc
  // comments on both tables.
  identityRecord: "idr",
  jurisdictionRenewalLink: "jrl",
  // §36 SYS-001..008 "Widgets, Voice, Wearables & System Integrations" — see
  // packages/db/src/schema/widgets.ts's own doc comments on both tables.
  widgetPreference: "wpref",
  appIntentLog: "ail",
  // FIN-003/FIN-005 — see packages/db/src/schema/finance.ts's detectedIncomeStreams/liabilities doc
  // comments (financialAccount/financialTransaction above were already reserved for the rest of §19).
  detectedIncomeStream: "fis",
  liability: "liab",
  // §AI-002 "risk_policies" wiring — see packages/db/src/schema/pipeline.ts's riskPolicies doc comment.
  riskPolicy: "rpol",
  // §AI-003 prompt-injection detection/logging — see packages/db/src/schema/audit.ts's promptSecurityEvents.
  promptSecurityEvent: "pse",
  // PRIV-001 "exclude specific senders from a connection" — see packages/db/src/schema/connectors.ts's
  // connectionExclusions doc comment.
  connectionExclusion: "cex",
  // MAIL-006 "User sender rules" — see packages/db/src/schema/sender-rules.ts's senderRules doc comment.
  senderRule: "srule",
  // §34.1 L2 "prepare" tier — see packages/db/src/schema/automation.ts's preparedActions doc comment.
  preparedAction: "prep",
  // FIN-002 "preserve provider transaction ID history and transaction revisions" — see
  // packages/db/src/schema/finance.ts's transactionRevisions doc comment.
  transactionRevision: "ftxnrev",
  // HOMEOS-004/VEH-003/VEH-004 — see packages/db/src/schema/assets.ts's maintenanceRules/registrationRecords
  // doc comments.
  maintenanceRule: "mrule",
  registrationRecord: "regrec",
  // §35 SHARE-004/005/006/007 — see packages/db/src/schema/sharing.ts's own doc comments on all three
  // tables.
  accessAuditEvent: "aae",
  caregiverDayPass: "cdp",
  legacyReleaseConfig: "lrc",
  // §40.1/40.2 "Entity Resolution" gap-close — reversible merge/unmerge for vehicles/properties/pets,
  // mirroring personMergeLineage ("pml" above) exactly. See packages/db/src/schema/assets.ts's own doc
  // comments on all three lineage tables.
  vehicleMergeLineage: "vml",
  propertyMergeLineage: "prml",
  petMergeLineage: "petml",
  // §37.2 Desktop requirements (DSK-001..008) — see packages/db/src/schema/desktop.ts's own doc comments
  // on all four tables for exactly what's real vs. structural-only in this pass.
  desktopDeviceSetting: "dds",
  localCacheManifest: "lcm",
  deepLinkRoute: "dlr",
  batchAction: "bka",
  // §39.2 "Model routing, versioning and evaluation" — see packages/db/src/schema/pipeline.ts's
  // modelRegistry/modelEvalRuns doc comments for what each table is for.
  modelRegistryEntry: "mreg",
  modelEvalRun: "mevr",
  // §48 "Product Analytics, Experimentation & Growth" — see packages/db/src/schema/analytics.ts's
  // productEvents doc comment.
  productEvent: "pev",
  // §42.3/42.4 domain event taxonomy — see packages/core/src/events/taxonomy.ts's DomainEventEnvelopeSchema
  // and services/api/src/events/event-bus.service.ts.
  domainEvent: "devt",
  // §43 CONN-001 — see packages/db/src/schema/connectors.ts's webhookSubscriptions doc comment.
  webhookSubscription: "whsub",
  // §42.5 "Historical backfill... resumable" — see packages/db/src/schema/connectors.ts's syncRuns doc
  // comment and services/api/src/modules/connectors/sync-run.util.ts.
  syncRun: "syncrun",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function randomToken(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${randomToken(16)}`;
}

export function isIdOfKind(id: string, kind: IdKind): boolean {
  return id.startsWith(`${ID_PREFIXES[kind]}_`);
}
