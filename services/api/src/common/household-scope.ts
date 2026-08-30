import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * FAM-006 enforcement — a Drizzle condition ORing the caller's own rows with any row belonging to a
 * household they hold a delegated grant on (`householdIds`, already resolved by the caller via
 * `HouseholdService.delegatedHouseholdIds` for whatever delegation scope that domain uses). When
 * `visibilityCol` is given, a delegated household's rows additionally exclude `visibility: "private"` so a
 * member's explicitly private row doesn't leak to a caregiver just because they hold a household-wide
 * grant — the owner's own rows are never filtered by visibility either way.
 */
export function ownerOrDelegatedHouseholdCondition(
  userId: string,
  householdIds: string[],
  ownerCol: AnyPgColumn,
  householdCol: AnyPgColumn,
  visibilityCol?: AnyPgColumn,
) {
  if (householdIds.length === 0) return eq(ownerCol, userId);
  const householdCondition = visibilityCol ? and(inArray(householdCol, householdIds), ne(visibilityCol, "private"))! : inArray(householdCol, householdIds);
  return or(eq(ownerCol, userId), householdCondition)!;
}
