"use client";

import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

interface EntityRow {
  id: string;
  type: string;
  displayLabel: string;
  lifecycleState: string;
  createdAt: string;
}

/**
 * MVP §52.1 "AI: ...conservative entity linking" — found while auditing this session's own work: the
 * ingestion pipeline has written real canonical-entity/relationship/fact rows (an "asset" entity per
 * purchase line item, a "warranty" entity `covers`-linked to the asset it applies to) since before this
 * session, with no way for a user to ever see any of it. This is that missing "what does Veynlo know
 * about my stuff" browse surface — deliberately simple (a flat list, no graph visualization) since the
 * write path itself is still narrow (two entity types today), not a reason to under-build the read side.
 */
export default function EntitiesPage() {
  // Previously only `isLoading` was checked — a failed GET left `data` undefined forever, which fails
  // both the empty-state check (`data?.length === 0` is false when data is undefined) and the populated
  // check, silently rendering nothing below the header at all. Confirmed live: a 500 from /v1/entities
  // produced a blank page with no error, no retry, indistinguishable from a broken layout rather than a
  // retryable fetch failure — the same FetchError gap already closed on every other list page.
  const { data, error, isLoading, mutate } = useSWR<EntityRow[]>("/v1/entities", swrFetcher);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">What Veynlo knows</h1>
        <p className="mt-1 text-sm text-tertiary">Things Veynlo has identified from your purchases and documents — items, warranties, and how they relate.</p>
      </header>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && error && !data && (
        <FetchError what="what Veynlo knows" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !error && data?.length === 0 && (
        <EmptyState title="Nothing here yet" description="As Veynlo processes your purchases and documents, items it identifies will show up here." />
      )}

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((entity) => (
            <li key={entity.id}>
              <Link href={`/entities/${entity.id}`}>
                <Card className="transition-colors hover:bg-subtle">
                  <CardBody className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-primary">{entity.displayLabel}</p>
                      <p className="text-xs capitalize text-tertiary">{entity.type}</p>
                    </div>
                    <Badge tone="neutral">{entity.lifecycleState}</Badge>
                  </CardBody>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
