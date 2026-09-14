import { useEffect } from "react";
import { router } from "expo-router";
import { ApiError } from "@/lib/api-client";

/**
 * Mobile's half of the merged-record redirect — same rule as web's `useMergeRedirect`, same reasoning.
 *
 * A merged record's detail screen used to render "Not found" for a record whose history simply moved into
 * another one. That is reachable here from more directions than on web: a push notification about a
 * recall, a deep link, or a row the app had cached before the merge.
 *
 * `router.replace`, so Back does not land on the merged id and redirect again.
 */
export function useMergeRedirect(error: unknown, hrefFor: (survivingId: string) => string) {
  const mergedIntoId =
    error instanceof ApiError && typeof error.details?.mergedIntoId === "string" ? error.details.mergedIntoId : null;

  useEffect(() => {
    if (mergedIntoId) router.replace(hrefFor(mergedIntoId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedIntoId]);

  return mergedIntoId !== null;
}
