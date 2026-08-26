import { pgEnum } from "drizzle-orm/pg-core";

/** Shared enums referenced across multiple schema files. */
export const sensitivityTierEnum = pgEnum("sensitivity_tier", [
  "standard",
  "sensitive",
  "highly_sensitive",
  "secret",
]);

export const visibilityEnum = pgEnum("visibility", [
  "private",
  "household",
  "selected_people",
  "shared_link",
]);

export const confidenceBandEnum = pgEnum("confidence_band", [
  "verified",
  "high",
  "needs_review",
  "conflicting",
  "approximate",
]);

export const verificationStateEnum = pgEnum("verification_state", [
  "unverified",
  "user_confirmed",
  "user_corrected",
  "superseded",
]);
