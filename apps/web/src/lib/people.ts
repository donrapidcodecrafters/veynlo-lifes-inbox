/**
 * §14 "Contacts, People & Relationships" (PEO-001..005) — shared web-side constants for the People
 * domain. Mirrors `PERSON_RELATIONSHIP_SUGGESTIONS` (packages/db/src/schema/people.ts) verbatim; kept as a
 * plain local copy rather than an import because apps/web doesn't depend on @veynlo/db (a server-only
 * package — drizzle schema, DB driver, encryption), only @veynlo/core. `relationshipLabel` itself stays
 * free text everywhere (never enforced client- or server-side) — this is quick-pick vocabulary only.
 */
export const PERSON_RELATIONSHIP_SUGGESTIONS = [
  "spouse_partner",
  "child",
  "parent",
  "sibling",
  "caregiver",
  "friend",
  "doctor",
  "dentist",
  "teacher",
  "contractor",
  "plumber",
  "mechanic",
  "accountant",
  "other",
] as const;

const RELATIONSHIP_LABEL_DISPLAY: Record<string, string> = {
  spouse_partner: "Spouse/partner",
  child: "Child",
  parent: "Parent",
  sibling: "Sibling",
  caregiver: "Caregiver",
  friend: "Friend",
  doctor: "Doctor",
  dentist: "Dentist",
  teacher: "Teacher",
  contractor: "Contractor",
  plumber: "Plumber",
  mechanic: "Mechanic",
  accountant: "Accountant",
  other: "Other",
};

/** A relationship label is free text (never a DB enum), so an arbitrary user-typed value needs a
 * presentable fallback — title-cased with underscores turned into spaces — rather than showing the raw
 * suggestion key (e.g. "spouse_partner") verbatim when it isn't one of the known suggestions. */
export function relationshipLabelText(label: string): string {
  const known = RELATIONSHIP_LABEL_DISPLAY[label];
  if (known) return known;
  return label
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
