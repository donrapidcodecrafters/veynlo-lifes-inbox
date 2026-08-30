import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { api } from "./api-client";

interface ConnectionHealth {
  health: string;
}

/**
 * §54.2 launch criteria #2 "initial processing shows incremental useful discoveries rather than an empty
 * dashboard" — mirrors the web app's useBackfillStatus. A connection's health is "initializing" for the
 * exact duration of its initial backfill, so this is a real signal for "new items may still be arriving
 * without the user doing anything." Polls /v1/connectors only while that's true and only while this
 * screen is focused (useFocusEffect already covers refetch-on-return; this adds refetch-while-sitting-on-
 * the-tab, which focus alone doesn't).
 */
export function useBackfillStatus(): boolean {
  const [backfilling, setBackfilling] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    const connections = await api.get<ConnectionHealth[]>("/v1/connectors").catch(() => []);
    setBackfilling(connections.some((c) => c.health === "initializing"));
  }, []);

  useFocusEffect(
    useCallback(() => {
      check();
      intervalRef.current = setInterval(check, 4000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }, [check]),
  );

  return backfilling;
}
