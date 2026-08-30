import useSWR from "swr";
import { swrFetcher } from "./api-client";

interface ConnectionHealth {
  health: string;
}

/**
 * §54.2 launch criteria #2 "initial processing shows incremental useful discoveries rather than an empty
 * dashboard" — a connection's health is "initializing" for the exact duration of its initial backfill
 * (flips to "healthy" when GmailAdapter/etc.'s initialSync finishes), so this is a real, already-existing
 * signal for "new items may still be arriving without the user doing anything." Self-limiting: polls
 * /v1/connectors only while that's true, and stops once every connection has resolved one way or another.
 */
export function useBackfillStatus(): boolean {
  const { data } = useSWR<ConnectionHealth[]>("/v1/connectors", swrFetcher, {
    refreshInterval: (latest) => (latest?.some((c) => c.health === "initializing") ? 4000 : 0),
  });
  return data?.some((c) => c.health === "initializing") ?? false;
}
