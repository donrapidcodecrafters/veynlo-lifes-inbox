import { useEffect } from "react";
import { useAuth } from "@/lib/auth-context";
import { syncPurchasesIdentity } from "@/lib/purchases";

/** Renders nothing — keeps RevenueCat's logged-in identity aligned with Veynlo's own auth state,
 * same "drain a side effect off the render tree" shape as NotificationCaptureDrain/ShareIntentDrain. */
export function PurchasesSync() {
  const { user } = useAuth();

  useEffect(() => {
    syncPurchasesIdentity(user?.id ?? null).catch(() => {});
  }, [user?.id]);

  return null;
}
