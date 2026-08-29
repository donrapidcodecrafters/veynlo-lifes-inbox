import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";

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

/** "Shared by me" audit view — mirrors the web Settings > Shared links page. No "shared with me"
 * counterpart: a share link is a bearer token (anyone with the URL), not an account-level grant. */
export default function SharedLinksScreen() {
  const { theme } = useAppTheme();
  const [links, setLinks] = useState<ShareLinkRow[] | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLinks(await api.get<ShareLinkRow[]>("/v1/shared-links"));
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function revoke(id: string) {
    setRevokingId(id);
    try {
      await api.post(`/v1/shared-links/${id}/revoke`);
      await load();
    } finally {
      setRevokingId(null);
    }
  }

  const isExpired = (link: ShareLinkRow) => link.expiresAt !== null && new Date(link.expiresAt) < new Date();

  return (
    <Screen>
      <ScreenHeader title="Shared links" subtitle="Every link you've created to share something with someone outside Veynlo." />

      {!links && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {links?.length === 0 && (
        <EmptyState title="Nothing shared yet" description="Share a document, calendar event, or needs-you item and it'll show up here." />
      )}

      {links && links.length > 0 && (
        <Card style={{ gap: 10 }}>
          {links.map((link) => {
            const revoked = link.revokedAt !== null;
            const expired = isExpired(link);
            return (
              <View key={link.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                      {RESOURCE_LABEL[link.resourceType] ?? link.resourceType}
                    </Text>
                    {revoked ? (
                      <Badge tone="neutral">revoked</Badge>
                    ) : expired ? (
                      <Badge tone="neutral">expired</Badge>
                    ) : (
                      <Badge tone="positive">active</Badge>
                    )}
                  </View>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                    Created {new Date(link.createdAt).toLocaleDateString()}
                    {link.expiresAt && !revoked && ` · expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                  </Text>
                </View>
                {!revoked && !expired && (
                  <Button variant="ghost" onPress={() => revoke(link.id)} loading={revokingId === link.id}>
                    Revoke
                  </Button>
                )}
              </View>
            );
          })}
        </Card>
      )}
    </Screen>
  );
}
