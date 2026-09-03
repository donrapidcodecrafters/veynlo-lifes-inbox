"use client";

import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

// Bug fix: this previously typed `state` as only "queued" | "sent" | "suppressed", but the backend's real
// enum (packages/core's NotificationStateSchema, matching notification-delivery.service.ts's writes) is
// "queued" | "sent" | "suppressed" | "opened" | "actioned" | "failed". Nothing currently writes the other
// three, so this was dormant, not visibly broken — but a narrower-than-reality type here is exactly the
// kind of gap that silently degrades the moment the backend starts using them (e.g. a future "mark as
// actioned" feature): STATE_TONE and the status-line logic below would both fall through their defaults
// instead of reflecting the real state, and TypeScript wouldn't catch the mismatch since the API response
// isn't statically checked against this interface. Widened to match, with real handling for each rather
// than a silent fallback.
interface NotificationRecord {
  id: string;
  priority: string;
  channel: string;
  title: string;
  body: string;
  state: "queued" | "sent" | "suppressed" | "opened" | "actioned" | "failed";
  suppressionReason: string | null;
  scheduledFor: string;
  sentAt: string | null;
  openedAt: string | null;
}

const STATE_TONE: Record<NotificationRecord["state"], "positive" | "warning" | "neutral" | "critical"> = {
  sent: "positive",
  queued: "neutral",
  suppressed: "warning",
  opened: "positive",
  actioned: "positive",
  failed: "critical",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function statusLine(n: NotificationRecord): string {
  // "opened"/"actioned" both mean the notification was delivered (and then read/acted on) — same "Sent
  // at ..." framing as a plain "sent", the trailing "· Opened ..." suffix below already covers the extra
  // detail. Treating them as their own unhandled bucket would wrongly show "Scheduled for <scheduledFor>"
  // for a notification that was actually delivered.
  if ((n.state === "sent" || n.state === "opened" || n.state === "actioned") && n.sentAt) {
    return `Sent ${formatWhen(n.sentAt)}`;
  }
  if (n.state === "suppressed") {
    // Every other snake_case value this app surfaces gets its underscores turned into spaces first (see
    // apps/mobile's equivalent history screen, already fixed for the same reason) — this one didn't, so a
    // real suppression reason like "quiet_intensity_preference" or the new "category_muted" (§NOT-001)
    // showed up on screen with the underscores still in it.
    return `Suppressed${n.suppressionReason ? ` — ${n.suppressionReason.replace(/_/g, " ")}` : ""} (would've sent ${formatWhen(n.scheduledFor)})`;
  }
  if (n.state === "failed") {
    return `Failed to send (was scheduled for ${formatWhen(n.scheduledFor)})`;
  }
  return `Scheduled for ${formatWhen(n.scheduledFor)}`;
}

export default function NotificationHistoryPage() {
  const { data, isLoading, error, mutate } = useSWR<NotificationRecord[]>("/v1/notifications", swrFetcher);

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

      {/* Bug fix: found live via a forced 500 on GET /v1/notifications — `isLoading` goes false once the
          request settles (success OR error), but `data` stays undefined either way, so this page had no
          branch left to render for a real fetch failure: not the loading skeleton (isLoading is false),
          not the empty state (`data?.length === 0` is false when data is undefined), just the header with
          nothing underneath. Every sibling settings page now has a FetchError branch for exactly this. */}
      {!isLoading && error && !data && (
        <FetchError what="your notification history" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !error && data?.length === 0 && (
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
                    {statusLine(n)}
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
