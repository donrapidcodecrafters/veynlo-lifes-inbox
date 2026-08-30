import type { ReactNode } from "react";
import { Card, CardBody } from "@/components/ui/card";

export interface Evidence {
  sourceEventId: string;
  kind: string;
  subjectLine: string | null;
  snippet: string | null;
  fromAddress: string | null;
  occurredAt: string;
  provider: string | null;
  rawContentRef: string | null;
}

const KIND_LABEL: Record<string, string> = {
  email_message: "Email",
  manual_entry: "Added manually",
  calendar_feed_event: "Calendar feed",
};

const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", ics: "Calendar feed" };

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** MAIL-007 — highlights occurrences of the resource's own already-extracted field values inside the
 * evidence snippet, via plain case-insensitive substring matching (no character-offset infrastructure
 * exists to do anything more precise — see packages/db/src/schema/graph.ts's evidenceRefs comment). */
function highlightSnippet(snippet: string, terms: string[] | undefined): ReactNode {
  const validTerms = (terms ?? []).filter((t) => t.trim().length >= 3);
  if (validTerms.length === 0) return snippet;
  const pattern = new RegExp(`(${validTerms.map(escapeRegExp).join("|")})`, "gi");
  return snippet.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded bg-warning-subtle px-0.5 text-warning-subtle-text">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/** §39.2 "evidence view" — Absolute Product Rule "Evidence before assertion": every material extracted
 * fact must retain source provenance the user can inspect ("why am I seeing this?"). Shows whatever was
 * actually captured at ingest time (subject/snippet/sender/received date/source) rather than the full
 * original message, which this app deliberately never stores — see source_events' schema comment. */
export function EvidenceCard({ evidence, highlightTerms }: { evidence: Evidence | null; highlightTerms?: string[] }) {
  if (!evidence) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm font-medium text-primary">Evidence</p>
          <p className="mt-1 text-sm text-tertiary">No source evidence is available for this item — it may have come from seed data or a domain that isn&apos;t linked to a source yet.</p>
        </CardBody>
      </Card>
    );
  }
  return (
    <Card>
      <CardBody className="space-y-2">
        <p className="text-sm font-medium text-primary">Evidence — where this came from</p>
        <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
          {evidence.subjectLine && (
            <>
              <dt className="text-tertiary">Subject</dt>
              <dd className="text-primary">{evidence.subjectLine}</dd>
            </>
          )}
          {evidence.fromAddress && (
            <>
              <dt className="text-tertiary">From</dt>
              <dd className="text-primary">{evidence.fromAddress}</dd>
            </>
          )}
          {evidence.snippet && (
            <>
              <dt className="text-tertiary">Snippet</dt>
              <dd className="text-primary">{highlightSnippet(evidence.snippet, highlightTerms)}</dd>
            </>
          )}
          <dt className="text-tertiary">Source</dt>
          <dd className="text-primary">
            {KIND_LABEL[evidence.kind] ?? evidence.kind}
            {evidence.provider && ` · ${PROVIDER_LABEL[evidence.provider] ?? evidence.provider}`}
          </dd>
          <dt className="text-tertiary">Received</dt>
          <dd className="text-primary">{new Date(evidence.occurredAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}</dd>
        </dl>
        {evidence.rawContentRef && (
          <a href={evidence.rawContentRef} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand hover:underline">
            Open in {PROVIDER_LABEL[evidence.provider ?? ""] ?? "original provider"}
          </a>
        )}
      </CardBody>
    </Card>
  );
}
