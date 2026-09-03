/**
 * §40.3 Subscription state machine — "paused" is a real named state (`candidate → trial/active →
 * renewal upcoming / price changed / paused → cancellation pending → canceled/expired`), but pausing a
 * subscription is only ever meaningful when the underlying merchant/provider actually offers a pause
 * option instead of a hard cancel — this app has no direct-cancel/pause API integration with any merchant
 * (see merchant-cancellation-steps.ts's own doc comment on why that's deliberately never attempted), so
 * there is no live signal to check against a real provider.
 *
 * This is the same "small, honest, currently-empty allowlist, structured so a real one can be added later
 * without touching the call site" pattern as PAUSE_CAPABLE_MERCHANT_NAMES below being empty today: nothing
 * in `packages/db/src/seed/merchant-cancellation-steps.ts`'s curated cancellation steps mentions a pause
 * option for any seeded merchant (checked directly — every seeded row describes a cancel flow, never a
 * pause one), so `CommerceService.pauseSubscription` correctly rejects every subscription today. The state
 * and transition exist and are fully exercised by tests with a merchant name added directly to the
 * allowlist; only the "which real merchants support this" data is still unknown.
 */
export const PAUSE_CAPABLE_MERCHANT_NAMES: ReadonlySet<string> = new Set<string>([
  // No merchant is currently known/seeded to support pausing a subscription (rather than a hard cancel) —
  // see this file's own doc comment. Add a merchant's exact `merchants.displayName` here once a real,
  // sourced pause flow is confirmed for it.
]);

/** Case-insensitive membership check against `capableMerchants` (defaults to the real allowlist above) —
 * a merchant display name comparison, same normalize-and-compare posture as biller-category.ts's
 * `categorizeBiller` and findOrCreateMerchant's own exact-match lookup, just case-insensitive since this
 * is a small curated allowlist rather than a live database match. Takes the allowlist as a parameter
 * (rather than only ever reading the module-level constant) purely so tests can exercise the real
 * transition logic in `CommerceService.pauseSubscription` against a hypothetical pause-capable merchant
 * without mutating shared module state between test runs. */
export function merchantSupportsPause(merchantDisplayName: string | null, capableMerchants: ReadonlySet<string> = PAUSE_CAPABLE_MERCHANT_NAMES): boolean {
  if (!merchantDisplayName) return false;
  const normalized = merchantDisplayName.trim().toLowerCase();
  for (const name of capableMerchants) {
    if (name.trim().toLowerCase() === normalized) return true;
  }
  return false;
}
