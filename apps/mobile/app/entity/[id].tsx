import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { FetchError } from "@/components/fetch-error";

interface EntityDetail {
  entity: { id: string; type: string; displayLabel: string; lifecycleState: string };
  facts: { id: string; predicate: string; valueJson: unknown; confidenceBand: string; evidence: { id: string; locator: string; excerpt: string | null }[] }[];
  relationships: {
    outgoing: { id: string; type: string; otherEntityId: string; otherEntityLabel: string }[];
    incoming: { id: string; type: string; otherEntityId: string; otherEntityLabel: string }[];
  };
}

export default function EntityDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<EntityDetail | null | undefined>(undefined);
  // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx): a `.then` with no `.catch` on a
  // mount-time fetch becomes an unhandled promise rejection on any transient network failure, which React
  // Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just
  // this screen.
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Found live: no reusable load function existed here — a transient 500/network error left the user
  // permanently stuck on "Something went wrong" with no in-place recovery. Mirrors bill/[id].tsx's
  // identical fix: wired to FetchError's own Retry button instead.
  const load = useCallback(() => {
    setError(null);
    api
      .get<EntityDetail | null>(`/v1/entities/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this item"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) {
    return (
      <Screen>
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This item doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const { entity, facts, relationships } = data;
  // Direction matters for how a relationship reads: an outgoing "covers" (this warranty covers that
  // asset) is not the same sentence as an incoming one (that warranty covers this asset) — mirrors
  // apps/web's identical distinction in its own entity detail page.
  const allRelationships = [
    ...relationships.outgoing.map((r) => ({ ...r, direction: "outgoing" as const })),
    ...relationships.incoming.map((r) => ({ ...r, direction: "incoming" as const })),
  ];

  return (
    <Screen>
      <ScreenHeader title={entity.displayLabel} subtitle={entity.type} />
      <Badge tone="neutral">{entity.lifecycleState}</Badge>

      {allRelationships.length > 0 && (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Related</Text>
          {allRelationships.map((r) => (
            <Text accessibilityRole="button"
              key={r.id}
              style={{ fontSize: 13, color: theme.colors.brandDefault }}
              onPress={() => router.push(`/entity/${r.otherEntityId}`)}
            >
              {/* Found live: relationship type (e.g. "accessory_of") rendered with its underscore intact —
                  "Headphones charging case accessory_of this" — while this same screen already humanizes
                  every other raw enum-ish value it shows (fact.predicate, fact.confidenceBand both below,
                  via `.replace(/_/g, " ")`). Matches that existing convention instead. */}
              {r.direction === "outgoing"
                ? `${r.type.replace(/_/g, " ")} ${r.otherEntityLabel}`
                : `${r.otherEntityLabel} ${r.type.replace(/_/g, " ")} this`}
            </Text>
          ))}
        </Card>
      )}

      {facts.length > 0 && (
        <Card style={{ gap: 10 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>What Veynlo found</Text>
          {facts.map((fact) => (
            <View key={fact.id} style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary, textTransform: "capitalize" }}>
                  {fact.predicate.replace(/_/g, " ")}
                </Text>
                <Badge tone="neutral">{fact.confidenceBand.replace(/_/g, " ")}</Badge>
              </View>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary, fontFamily: "monospace" }}>
                {JSON.stringify(fact.valueJson)}
              </Text>
              {fact.evidence.length > 0 && (
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                  Why: {fact.evidence.map((e) => e.excerpt).filter(Boolean).join("; ")}
                </Text>
              )}
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}
