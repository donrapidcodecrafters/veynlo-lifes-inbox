import { Linking, Pressable, Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";
import { Card } from "@/components/card";
import type { AppTheme } from "@/lib/theme";

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
function renderSnippet(snippet: string, terms: string[] | undefined, theme: AppTheme) {
  const validTerms = (terms ?? []).filter((t) => t.trim().length >= 3);
  if (validTerms.length === 0) return snippet;
  const pattern = new RegExp(`(${validTerms.map(escapeRegExp).join("|")})`, "gi");
  return snippet.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} style={{ backgroundColor: theme.colors.warningSubtleBg, color: theme.colors.warningSubtleText }}>
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

/** Mirrors apps/web/src/components/evidence-card.tsx — see its doc comment for why only a snippet/subject
 * is shown rather than the full original message (never stored). */
export function EvidenceCard({ evidence, highlightTerms }: { evidence: Evidence | null; highlightTerms?: string[] }) {
  const { theme } = useAppTheme();

  if (!evidence) {
    return (
      <Card style={{ gap: 4 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Evidence</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          No source evidence is available for this item — it may have come from seed data or a domain that isn&apos;t linked to a source yet.
        </Text>
      </Card>
    );
  }

  const rows: Array<[string, string]> = [];
  if (evidence.subjectLine) rows.push(["Subject", evidence.subjectLine]);
  if (evidence.fromAddress) rows.push(["From", evidence.fromAddress]);
  rows.push(["Source", `${KIND_LABEL[evidence.kind] ?? evidence.kind}${evidence.provider ? ` · ${PROVIDER_LABEL[evidence.provider] ?? evidence.provider}` : ""}`]);
  rows.push([
    "Received",
    new Date(evidence.occurredAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
  ]);

  const providerLabel = evidence.provider ? (PROVIDER_LABEL[evidence.provider] ?? "original provider") : "original provider";

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Evidence — where this came from</Text>
      <View style={{ gap: 4 }}>
        {evidence.snippet && (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary, width: 72 }}>Snippet</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{renderSnippet(evidence.snippet, highlightTerms, theme)}</Text>
          </View>
        )}
        {rows.map(([label, value]) => (
          <View key={label} style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary, width: 72 }}>{label}</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{value}</Text>
          </View>
        ))}
      </View>
      {evidence.rawContentRef && (
        <Pressable
          onPress={() => Linking.openURL(evidence.rawContentRef!)}
          accessibilityRole="link"
          accessibilityLabel={`Open in ${providerLabel}`}
        >
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>Open in {providerLabel}</Text>
        </Pressable>
      )}
    </Card>
  );
}
