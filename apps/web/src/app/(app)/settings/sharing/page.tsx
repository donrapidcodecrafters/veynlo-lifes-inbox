"use client";

import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

type ResourceGrantRight = "view" | "edit" | "manage";

interface SharedByMeGrant {
  kind: "grant";
  id: string;
  resourceType: string;
  resourceTypeLabel: string;
  resourceLabel: string | null;
  right: ResourceGrantRight;
  granteeEmail: string;
  expiresAt: string | null;
  grantedAt: string;
}
interface SharedByMeLink {
  kind: "share_link";
  id: string;
  resourceType: string;
  resourceTypeLabel: string;
  resourceLabel: string | null;
  hasPasscode: boolean;
  expiresAt: string | null;
  createdAt: string;
}
interface SharedByMe {
  grants: SharedByMeGrant[];
  links: SharedByMeLink[];
}
interface SharedWithMeGrant {
  id: string;
  resourceType: string;
  resourceTypeLabel: string;
  resourceLabel: string | null;
  right: ResourceGrantRight;
  granterEmail: string;
  expiresAt: string | null;
  grantedAt: string;
}

const RIGHT_LABELS: Record<ResourceGrantRight, string> = { view: "Can view", edit: "Can edit", manage: "Can manage" };

function expiryText(expiresAt: string | null): string {
  return expiresAt ? `expires ${new Date(expiresAt).toLocaleDateString()}` : "until revoked";
}

/**
 * §35 SHARE-007 "Share audit" — "Owners can see active shares and access history... Central 'Shared by
 * me' and 'Shared with me' screens." Previously sharing state was only visible per-resource (open a
 * specific list/document/etc. and look at its own ShareResourcePanel) — this is the first cross-cutting
 * view. Backed by SharingHubService (services/api/src/modules/sharing/sharing-hub.service.ts), which
 * aggregates across every resource type SharingService knows about.
 */
export default function SharingHubPage() {
  const { data: byMe, mutate: mutateByMe, error: byMeError, isLoading: byMeLoading } = useSWR<SharedByMe>("/v1/sharing/shared-by-me", swrFetcher);
  const { data: withMe, mutate: mutateWithMe, error: withMeError, isLoading: withMeLoading } = useSWR<SharedWithMeGrant[]>("/v1/sharing/shared-with-me", swrFetcher);

  async function revokeGrant(grantId: string, label: string) {
    if (!window.confirm(`Stop sharing "${label}"?`)) return;
    try {
      await api.delete(`/v1/sharing/grants/${grantId}`);
      mutateByMe();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Couldn't remove that. Please try again.");
    }
  }

  async function revokeLink(linkId: string, label: string) {
    if (!window.confirm(`Revoke the public link for "${label}"? Anyone using it loses access immediately.`)) return;
    try {
      await api.delete(`/v1/sharing/share-links/${linkId}`);
      mutateByMe();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "Couldn't revoke that link. Please try again.");
    }
  }

  const hasByMe = (byMe?.grants.length ?? 0) > 0 || (byMe?.links.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Sharing</h1>
        <p className="text-sm text-tertiary">Everything you&apos;ve shared out, and everything shared with you — in one place.</p>
      </header>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">More ways to share</h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Card>
            <CardBody className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Caregiver day pass</p>
                <p className="text-sm text-tertiary">A time-boxed logistics packet for a babysitter or house-sitter.</p>
              </div>
              <Link href="/settings/sharing/caregiver-passes">
                <Button variant="secondary">Open</Button>
              </Link>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[0.9375rem] font-medium text-primary">Legacy release</p>
                <p className="text-sm text-tertiary">Preconfigure a trusted contact to receive selected information later.</p>
              </div>
              <Link href="/settings/sharing/legacy-release">
                <Button variant="secondary">Open</Button>
              </Link>
            </CardBody>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">Shared by me</h2>
        {byMeLoading && <p className="text-sm text-tertiary">Loading…</p>}
        {byMeError && <FetchError message={byMeError instanceof ApiError ? byMeError.message : undefined} onRetry={() => mutateByMe()} what="what you've shared" />}
        {byMe && !hasByMe && (
          <EmptyState
            title="Nothing shared yet"
            description="When you share a list, document, purchase, or anything else with someone's account or a public link, it'll show up here."
          />
        )}
        {byMe && hasByMe && (
          <div className="space-y-2">
            {byMe.grants.map((g) => (
              <Card key={g.id}>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge>{g.resourceTypeLabel}</Badge>
                      <p className="truncate text-[0.9375rem] font-medium text-primary">{g.resourceLabel ?? g.resourceTypeLabel}</p>
                    </div>
                    <p className="text-sm text-tertiary">
                      With {g.granteeEmail} — {RIGHT_LABELS[g.right]}, {expiryText(g.expiresAt)}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => revokeGrant(g.id, g.resourceLabel ?? g.resourceTypeLabel)}>
                    Revoke
                  </Button>
                </CardBody>
              </Card>
            ))}
            {byMe.links.map((l) => (
              <Card key={l.id}>
                <CardBody className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone="info">{l.resourceTypeLabel}</Badge>
                      <p className="truncate text-[0.9375rem] font-medium text-primary">{l.resourceLabel ?? l.resourceTypeLabel}</p>
                    </div>
                    <p className="text-sm text-tertiary">
                      Public link{l.hasPasscode ? " (passcode-protected)" : ""} — {expiryText(l.expiresAt)}
                    </p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => revokeLink(l.id, l.resourceLabel ?? l.resourceTypeLabel)}>
                    Revoke
                  </Button>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">Shared with me</h2>
        {withMeLoading && <p className="text-sm text-tertiary">Loading…</p>}
        {withMeError && <FetchError message={withMeError instanceof ApiError ? withMeError.message : undefined} onRetry={() => mutateWithMe()} what="what's shared with you" />}
        {withMe && withMe.length === 0 && (
          <EmptyState title="Nothing shared with you yet" description="Anything another Veynlo account shares directly with you will show up here." />
        )}
        {withMe && withMe.length > 0 && (
          <div className="space-y-2">
            {withMe.map((g) => (
              <Card key={g.id}>
                <CardBody>
                  <div className="flex items-center gap-2">
                    <Badge>{g.resourceTypeLabel}</Badge>
                    <p className="truncate text-[0.9375rem] font-medium text-primary">{g.resourceLabel ?? g.resourceTypeLabel}</p>
                  </div>
                  <p className="text-sm text-tertiary">
                    From {g.granterEmail} — {RIGHT_LABELS[g.right]}, {expiryText(g.expiresAt)}
                  </p>
                </CardBody>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
