"use client";

import Link from "next/link";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";

interface NotificationRecord {
  id: string;
  priority: string;
  channel: string;
  title: string;
  body: string;
  state: "queued" | "sent" | "suppressed";
  suppressionReason: string | null;
  scheduledFor: string;
  sentAt: string | null;
  openedAt: string | null;
}

const STATE_TONE: Record<string, "positive" | "warning" | "neutral"> = {
  sent: "positive",
  queued: "neutral",
  suppressed: "warning",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function NotificationHistoryPage() {
  const { data, isLoading } = useSWR<NotificationRecord[]>("/v1/notifications", swrFetcher);

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Notification history</h1>
        <p className="mt-1 text-sm text-tertiary">Everything Veynlo has sent or considered sending you.</p>
      </header>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && data?.length === 0 && (
        <EmptyState title="No notifications yet" description="When Veynlo sends you something, it'll show up here." />
      )}

      {!isLoading && data && data.length > 0 && (
        <ul className="space-y-3">
          {data.map((n) => (
            <li key={n.id}>
              <Card>
                <CardBody className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge tone={STATE_TONE[n.state] ?? "neutral"}>{n.state}</Badge>
                        <Badge tone="neutral">{n.priority}</Badge>
                        <span className="text-xs uppercase tracking-wide text-tertiary">{n.channel}</span>
                      </div>
                      <p className="text-[0.9375rem] font-medium text-primary">{n.title}</p>
                      <p className="text-sm text-tertiary">{n.body}</p>
                    </div>
                  </div>
                  <p className="text-xs text-tertiary">
                    {n.state === "sent" && n.sentAt
                      ? `Sent ${formatWhen(n.sentAt)}`
                      : n.state === "suppressed"
                        ? `Suppressed${n.suppressionReason ? ` — ${n.suppressionReason}` : ""} (would've sent ${formatWhen(n.scheduledFor)})`
                        : `Scheduled for ${formatWhen(n.scheduledFor)}`}
                    {n.openedAt ? ` · Opened ${formatWhen(n.openedAt)}` : ""}
                  </p>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
