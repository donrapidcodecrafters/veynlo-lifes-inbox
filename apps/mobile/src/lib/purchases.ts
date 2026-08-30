import { Platform } from "react-native";
import Purchases from "react-native-purchases";

/**
 * Native IAP (App Store §3.1.1 / Play Billing) — Apple requires native purchases for digital
 * subscriptions, so the mobile app must never route through the web Stripe checkout the way
 * `apps/web` does. Uses the same "entitlement id == PlanKey" convention already established by
 * `RevenueCatService` server-side: an offering's identifier in the RevenueCat dashboard must equal
 * the Veynlo `planKey` ("plus" | "family" | "pro_agent"), and its monthly/annual packages map onto
 * our `Interval` type directly.
 */

let configured = false;

function apiKeyForPlatform(): string | undefined {
  if (Platform.OS === "ios") return process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
  if (Platform.OS === "android") return process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY;
  return undefined;
}

/** Mirrors the server's `isRevenueCatConfigured()` — optional in dev, a clear "not configured" state
 * rather than a crash when no API key is present for this platform/build. */
export function isPurchasesAvailable(): boolean {
  return Platform.OS !== "web" && Boolean(apiKeyForPlatform());
}

function ensureConfigured(): boolean {
  if (!isPurchasesAvailable()) return false;
  if (!configured) {
    Purchases.configure({ apiKey: apiKeyForPlatform()! });
    configured = true;
  }
  return true;
}

/** Keeps RevenueCat's `app_user_id` in sync with Veynlo's own user id — required for
 * `RevenueCatService.handleWebhook` to attribute a purchase event to the right user. Call on every
 * auth state change (sign-in, sign-out, app launch with an existing session). */
export async function syncPurchasesIdentity(userId: string | null): Promise<void> {
  if (!ensureConfigured()) return;
  if (userId) {
    await Purchases.logIn(userId);
  } else {
    // Throws if already anonymous (e.g. first launch, never signed in) — benign, nothing to undo.
    await Purchases.logOut().catch(() => {});
  }
}

export class PurchasesNotAvailableError extends Error {}
export class PurchaseCancelledError extends Error {}

export async function purchasePlan(planKey: string, interval: "month" | "year"): Promise<void> {
  if (!ensureConfigured()) {
    throw new PurchasesNotAvailableError("In-app purchases aren't available on this build yet.");
  }
  const offerings = await Purchases.getOfferings();
  const offering = offerings.all[planKey];
  const pkg = interval === "month" ? offering?.monthly : offering?.annual;
  if (!pkg) {
    throw new PurchasesNotAvailableError("This plan isn't available for purchase yet.");
  }
  try {
    await Purchases.purchasePackage(pkg);
  } catch (err) {
    if (isUserCancelledError(err)) throw new PurchaseCancelledError("Purchase cancelled.");
    throw err;
  }
}

/**
 * Standard, expected native-app affordance for "I already paid for this on another device/a reinstall" —
 * previously missing entirely, which meant the only path back to an existing subscription's entitlements
 * was a fresh purchase, which is exactly what triggers a RevenueCat TRANSFER event server-side (see
 * RevenueCatService.handleWebhook's comment on that). Making restore easy to find reduces how often that
 * edge case gets hit in the first place.
 */
export async function restorePurchases(): Promise<void> {
  if (!ensureConfigured()) {
    throw new PurchasesNotAvailableError("In-app purchases aren't available on this build yet.");
  }
  await Purchases.restorePurchases();
}

function isUserCancelledError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { userCancelled?: boolean }).userCancelled === true;
}
