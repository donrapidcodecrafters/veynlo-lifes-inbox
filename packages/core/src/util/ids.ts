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
  entityMergeLineage: "eml",
  purchase: "pur",
  purchaseLine: "purl",
  returnCase: "ret",
  shipment: "shp",
  subscription: "sub",
  bill: "bil",
  warranty: "war",
  recurringStream: "rec",
  calendarEvent: "evt",
  scheduleConflict: "cnf",
  task: "tsk",
  trip: "trip",
  place: "plc",
  person: "per",
  organization: "org",
  savedItem: "sav",
  list: "lst",
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
  job: "job",
  adminUser: "adm",
  adminSession: "adms",
  extractorVersion: "exv",
  extractionRun: "exr",
  senderRule: "sndr",
  savedQuery: "svq",
  objectNote: "note",
  passwordResetToken: "prt",
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
