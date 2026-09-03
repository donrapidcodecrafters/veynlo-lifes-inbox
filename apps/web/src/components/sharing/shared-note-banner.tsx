"use client";

/**
 * SHARE-001 "optional message" — a short note the granter attached to a direct resourceGrant, shown to the
 * grantee on the shared resource's own detail page. Populated by each resource service's own detail
 * method (ListsService.listDetail, CommerceService.purchaseDetail, AssetsService.propertyDetail/
 * vehicleDetail, PetsService.detail) as `sharedNote` — null for owner/household access (there's no grant
 * to read a message off of) or when the granter left no note. Deliberately a tiny, single-purpose
 * component rather than folded into ShareResourcePanel: this renders for the RECIPIENT viewing a shared
 * resource, while ShareResourcePanel renders for the owner/manager managing who has access — different
 * viewers, different times.
 */
export function SharedNoteBanner({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <div className="rounded-lg border border-border-default bg-surface-subtle px-3 py-2 text-sm text-secondary">
      <span className="font-medium text-primary">Note from the owner: </span>
      {note}
    </div>
  );
}
