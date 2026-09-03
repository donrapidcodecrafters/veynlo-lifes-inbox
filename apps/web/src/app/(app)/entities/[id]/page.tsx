"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

// Same mapping the inbox/purchases pages use for confidenceBand — kept in sync so a fact flagged
// "needs_review" or "conflicting" doesn't read as identically trustworthy as one "verified".
const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

interface EntityDetail {
  entity: { id: string; type: string; displayLabel: string; lifecycleState: string; aliases: string[]; createdAt: string };
  facts: {
    id: string;
    predicate: string;
    valueJson: unknown;
    confidenceBand: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    evidence: { id: string; locator: string; excerpt: string | null }[];
  }[];
  relationships: {
    outgoing: { id: string; type: string; direction: "outgoing"; otherEntityId: string; otherEntityLabel: string }[];
    incoming: { id: string; type: string; direction: "incoming"; otherEntityId: string; otherEntityLabel: string }[];
  };
}

export default function EntityDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<EntityDetail | null>(`/v1/entities/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This item doesn't exist or you don't have access to it." />;

  const { entity, facts, relationships } = data;
  const allRelationships = [...relationships.outgoing, ...relationships.incoming];

  return (
    <div className="space-y-6">
      <Link href="/entities" className="text-sm text-tertiary hover:text-primary">
        ← Back to What Veynlo knows
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-primary">{entity.displayLabel}</h1>
          <p className="mt-1 text-sm capitalize text-tertiary">{entity.type}</p>
          {/* Found live: the API and this component's own EntityDetail type both carry `aliases` (the
              other names Veynlo has resolved to this same entity — the whole point of "conservative entity
              linking"), but nothing on the page ever rendered them. */}
          {entity.aliases.length > 0 && (
            <p className="mt-1 break-words text-xs text-tertiary">Also known as: {entity.aliases.join(", ")}</p>
          )}
        </div>
        <Badge tone="neutral">{entity.lifecycleState}</Badge>
      </header>

      {allRelationships.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Related</p>
            <ul className="space-y-1.5 text-sm">
              {allRelationships.map((r) => (
                <li key={r.id}>
                  <Link href={`/entities/${r.otherEntityId}`} className="text-brand hover:underline">
                    {r.direction === "outgoing" ? `${r.type} ${r.otherEntityLabel}` : `${r.otherEntityLabel} ${r.type} this`}
                  </Link>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      {facts.length > 0 && (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-medium text-primary">What Veynlo found</p>
            {facts.map((fact) => (
              <div key={fact.id} className="space-y-1 border-t border-border-subtle pt-3 first:border-t-0 first:pt-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium capitalize text-primary">{fact.predicate.replace(/_/g, " ")}</p>
                  <Badge tone={CONFIDENCE_TONE[fact.confidenceBand] ?? "neutral"}>{fact.confidenceBand.replace(/_/g, " ")}</Badge>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-subtle p-2 text-xs text-secondary">{JSON.stringify(fact.valueJson, null, 2)}</pre>
                {fact.evidence.length > 0 && (
                  <p className="text-xs text-tertiary">
                    Why: {fact.evidence.map((e) => e.excerpt).filter(Boolean).join("; ")}
                  </p>
                )}
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
