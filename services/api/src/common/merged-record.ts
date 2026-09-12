import { NotFoundException } from "@nestjs/common";

/**
 * The error a detail route raises when the record asked for was merged into another one.
 *
 * Merging is not deletion. The record's history did not go away — it moved. But every detail route
 * treated a merged row exactly like a missing one, so an old link, a bookmark, or a notification from
 * before the merge landed on "Vehicle not found", with no way to reach the thing that now holds that
 * vehicle's recalls, tyres and service history. A user who merged two duplicates a month ago has no idea
 * that is what happened; they see their vehicle reported as gone.
 *
 * So the 404 now carries the surviving id and clients redirect to it. Kept as a 404 rather than an HTTP
 * 301 deliberately: `fetch` follows a 301 transparently, which would return the surviving record's body
 * under the old URL — the page would render the right vehicle while the address bar still named the
 * merged one, and any link the user then copied would be wrong again. The client has to know a redirect
 * happened, so the status has to be one it stops on.
 *
 * `mergedIntoId` is disclosed only AFTER the caller's access to the merged record has been checked. It is
 * an id of a record they may not be allowed to see, and a 404 that reveals one to an unauthorised caller
 * is an enumeration oracle — the same shape as the household-id defect in DEF-089.
 */
export function mergedRecordException(resource: string, mergedIntoId: string): NotFoundException {
  return new NotFoundException({
    code: `${resource.toUpperCase()}_MERGED`,
    message: `This ${resource} was merged into another one.`,
    mergedIntoId,
  });
}

/** The shape a detail service returns to say "this exists, but it lives somewhere else now". */
export type MergedInto = { mergedIntoId: string };

export const isMergedInto = (value: unknown): value is MergedInto =>
  typeof value === "object" && value !== null && typeof (value as MergedInto).mergedIntoId === "string";
