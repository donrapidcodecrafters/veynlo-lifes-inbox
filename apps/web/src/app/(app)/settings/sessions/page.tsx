"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  platform: string | null;
  displayName: string | null;
  lastActiveAt: string | null;
  isCurrent: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web browser",
  ios: "iPhone/iPad",
  android: "Android",
  macos: "macOS app",
  windows: "Windows app",
  extension: "Browser extension",
};

export default function SessionsPage() {
  const { data: sessions, mutate } = useSWR<SessionRow[]>("/v1/auth/sessions", swrFetcher);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/auth/sessions/${id}/revoke`);
      await mutate();
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Devices &amp; sessions</h1>
        <p className="mt-1 text-sm text-tertiary">Everywhere you're currently signed in to Veynlo.</p>
      </header>

      <Card>
        <CardBody className="space-y-3">
          {!sessions && <p className="text-sm text-tertiary">Loading…</p>}
          {sessions?.map((s) => (
            <div
              key={s.id}
              className="flex flex-col gap-2 border-b border-border-subtle py-2 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-primary">
                    {s.displayName ?? PLATFORM_LABEL[s.platform ?? ""] ?? s.platform ?? "Unknown device"}
                  </p>
                  {s.isCurrent && <Badge tone="positive">This device</Badge>}
                </div>
                <p className="text-xs text-tertiary">
                  Signed in {new Date(s.createdAt).toLocaleDateString()} · last active{" "}
                  {s.lastActiveAt ? new Date(s.lastActiveAt).toLocaleDateString() : new Date(s.lastSeenAt).toLocaleDateString()}
                </p>
              </div>
              {!s.isCurrent && (
                <Button variant="ghost" size="sm" className="shrink-0 whitespace-nowrap self-start" onClick={() => revoke(s.id)} disabled={revokingId === s.id}>
                  {revokingId === s.id ? "Signing out…" : "Sign out"}
                </Button>
              )}
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
