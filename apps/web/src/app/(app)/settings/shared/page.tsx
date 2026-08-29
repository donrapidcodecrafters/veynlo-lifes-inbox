"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface ShareLinkRow {
  id: string;
  resourceType: string;
  resourceId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const RESOURCE_LABEL: Record<string, string> = {
  attention_item: "Needs-you item",
  document: "Document",
  calendar_event: "Calendar event",
};

/** "Shared by me" audit view (§Sharing expansion) — every link this user has ever created, active or
 * not. There's no "shared with me" counterpart here: a share link is a bearer token (anyone with the
 * URL), not an account-level grant, so there's no recipient identity to list it against. */
export default function SharedLinksPage() {
  const { data: links, mutate } = useSWR<ShareLinkRow[]>("/v1/shared-links", swrFetcher);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/shared-links/${id}/revoke`);
      await mutate();
    } finally {
      setRevokingId(null);
    }
  }

  const isExpired = (link: ShareLinkRow) => link.expiresAt !== null && new Date(link.expiresAt) < new Date();

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Shared links</h1>
        <p className="mt-1 text-sm text-tertiary">Every link you've created to share something with someone outside Veynlo.</p>
      </header>

      {!links && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}

      {links && links.length === 0 && (
        <EmptyState title="Nothing shared yet" description="Share a document, calendar event, or needs-you item and it'll show up here." />
      )}

      {links && links.length > 0 && (
        <Card>
          <CardBody className="space-y-3">
            {links.map((link) => {
              const revoked = link.revokedAt !== null;
              const expired = isExpired(link);
              return (
                <div
                  key={link.id}
                  className="flex flex-col gap-2 border-b border-border-subtle py-2 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-primary">{RESOURCE_LABEL[link.resourceType] ?? link.resourceType}</p>
                      {revoked ? (
                        <Badge tone="neutral">revoked</Badge>
                      ) : expired ? (
                        <Badge tone="neutral">expired</Badge>
                      ) : (
                        <Badge tone="positive">active</Badge>
                      )}
                    </div>
                    <p className="text-xs text-tertiary">
                      Created {new Date(link.createdAt).toLocaleDateString()}
                      {link.expiresAt && !revoked && ` · expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  {!revoked && !expired && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 whitespace-nowrap self-start"
                      onClick={() => revoke(link.id)}
                      disabled={revokingId === link.id}
                    >
                      {revokingId === link.id ? "Revoking…" : "Revoke"}
                    </Button>
                  )}
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
