import { SetMetadata } from "@nestjs/common";

export const ALLOW_DURING_DELETION_KEY = "allowDuringDeletion";

/**
 * PRIV-002 "grace period if used" — a `deletion_pending` account can sign in and reach a small allowlist
 * of routes (cancel the deletion, read its own `/me` status to show the countdown, sign out) so it isn't
 * permanently locked out the moment deletion is requested, but everything else on the API stays blocked
 * exactly as it was before the grace period existed (AuthGuard's own `deletion_pending` branch still
 * throws for any route not marked with this decorator). Deliberately opt-in per-route rather than
 * opt-out — a new route added later is blocked-during-deletion by default, which is the safer failure mode
 * for an account that's mid-teardown.
 */
export const AllowDuringDeletion = () => SetMetadata(ALLOW_DURING_DELETION_KEY, true);
