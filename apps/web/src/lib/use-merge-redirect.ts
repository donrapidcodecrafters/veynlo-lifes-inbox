"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api-client";

/**
 * Send the user to the surviving record when the one they asked for was merged away.
 *
 * Merging is not deletion — the record's history moved rather than disappeared — but every detail page
 * rendered a merged record exactly like a missing one. An old link, a bookmark, or a notification from
 * before the merge landed on "Vehicle not found", with no way to reach the vehicle that now holds that
 * vehicle's recalls, tyres and service history. A user who merged two duplicates weeks ago has no reason
 * to connect the two, so it reads as lost data.
 *
 * `router.replace`, not `push`: the merged URL should not sit in history, or Back from the surviving
 * record bounces straight into the redirect again and the user cannot get out.
 *
 * Returns nothing — it is a side effect on a fetch error the page is already holding, so a page adopts it
 * with one line and keeps its existing error rendering for every other failure.
 */
export function useMergeRedirect(error: unknown, hrefFor: (survivingId: string) => string) {
  const router = useRouter();
  const mergedIntoId =
    error instanceof ApiError && typeof error.details?.mergedIntoId === "string" ? error.details.mergedIntoId : null;

  useEffect(() => {
    if (mergedIntoId) router.replace(hrefFor(mergedIntoId));
    // `hrefFor` is a fresh closure on every render at most call sites; including it would re-fire the
    // redirect on each one. The id is the only thing that should re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedIntoId, router]);

  return mergedIntoId !== null;
}
