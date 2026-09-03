import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";

type ResourceGrantRight = "view" | "edit" | "manage";
const RIGHT_LABELS: Record<ResourceGrantRight, string> = { view: "Can view", edit: "Can edit", manage: "Can manage" };

interface SharedByMeGrant {
  kind: "grant";
  id: string;
  resourceTypeLabel: string;
  resourceLabel: string | null;
  right: ResourceGrantRight;
  granteeEmail: string;
  expiresAt: string | null;
}
interface SharedByMeLink {
  kind: "share_link";
  id: string;
  resourceTypeLabel: string;
  resourceLabel: string | null;
  hasPasscode: boolean;
  expiresAt: string | null;
}
interface SharedByMe {
  grants: SharedByMeGrant[];
  links: SharedByMeLink[];
}
interface SharedWithMeGrant {
  id: string;
  resourceTypeLabel: string;
  resourceLabel: string | null;
  right: ResourceGrantRight;
  granterEmail: string;
  expiresAt: string | null;
}

function expiryText(expiresAt: string | null): string {
  return expiresAt ? `expires ${new Date(expiresAt).toLocaleDateString()}` : "until revoked";
}

/**
 * §35 SHARE-007 "Central 'Shared by me' and 'Shared with me' screens" — mobile equivalent of apps/web's
 * settings/sharing/page.tsx, same /v1/sharing/* endpoints (SharingHubService).
 */
type RevokeTarget = { kind: "grant" | "link"; id: string; label: string };

export default function SharingHubScreen() {
  const { theme } = useAppTheme();
  const [byMe, setByMe] = useState<SharedByMe | null>(null);
  const [withMe, setWithMe] = useState<SharedWithMeGrant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Inline confirm state, not RN's Alert.alert — see list/[id].tsx's own doc comment on
  // `confirmingDeleteList`: react-native-web's Alert.alert is a permanent no-op stub (confirmed live —
  // tapping "Revoke" under `expo start --web` did nothing at all, no dialog, no error), so every
  // destructive-confirm flow in this app uses inline Card/Button state instead. Only one row can be
  // confirming at a time, mirroring list/[id].tsx's single `assigningItemId`.
  const [confirming, setConfirming] = useState<RevokeTarget | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [byMeResult, withMeResult] = await Promise.all([
        api.get<SharedByMe>("/v1/sharing/shared-by-me"),
        api.get<SharedWithMeGrant[]>("/v1/sharing/shared-with-me"),
      ]);
      setByMe(byMeResult);
      setWithMe(withMeResult);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load sharing info. Please try again.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmRevoke() {
    if (!confirming) return;
    setRevoking(true);
    setActionError(null);
    try {
      if (confirming.kind === "grant") {
        await api.delete(`/v1/sharing/grants/${confirming.id}`);
      } else {
        await api.delete(`/v1/sharing/share-links/${confirming.id}`);
      }
      setConfirming(null);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : confirming.kind === "grant" ? "Couldn't remove that. Please try again." : "Couldn't revoke that link. Please try again.");
    } finally {
      setRevoking(false);
    }
  }

  const hasByMe = (byMe?.grants.length ?? 0) > 0 || (byMe?.links.length ?? 0) > 0;

  return (
    <Screen>
      <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Sharing</Text>
      {loadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{loadError}</Text>}
      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {/* Caregiver day passes and legacy release are set up from veynlo.com/settings/sharing today —
          both involve longer, multi-step forms (categories, waiting periods, step-up confirmation) that
          fit the web settings surface better; this screen covers the SHARE-007 hub only. */}
      <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
        Set up a caregiver day pass or legacy release from veynlo.com/settings/sharing.
      </Text>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Shared by me</Text>
        {byMe && !hasByMe && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Nothing shared yet.</Text>}
        {byMe?.grants.map((g) => {
          const label = g.resourceLabel ?? g.resourceTypeLabel;
          const isConfirming = confirming?.kind === "grant" && confirming.id === g.id;
          return (
            <Card key={g.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{label}</Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                    With {g.granteeEmail} — {RIGHT_LABELS[g.right]}, {expiryText(g.expiresAt)}
                  </Text>
                </View>
                {!isConfirming && (
                  <Text accessibilityRole="button" style={{ fontSize: 13, color: theme.colors.critical }} onPress={() => setConfirming({ kind: "grant", id: g.id, label })}>
                    Revoke
                  </Text>
                )}
              </View>
              {isConfirming && (
                <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>Stop sharing &quot;{label}&quot;?</Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button variant="critical" onPress={confirmRevoke} loading={revoking}>
                        Revoke
                      </Button>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button variant="secondary" onPress={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </View>
                  </View>
                </View>
              )}
            </Card>
          );
        })}
        {byMe?.links.map((l) => {
          const label = l.resourceLabel ?? l.resourceTypeLabel;
          const isConfirming = confirming?.kind === "link" && confirming.id === l.id;
          return (
            <Card key={l.id} style={{ gap: 8 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{label}</Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                    Public link{l.hasPasscode ? " (passcode)" : ""} — {expiryText(l.expiresAt)}
                  </Text>
                </View>
                {!isConfirming && (
                  <Text accessibilityRole="button" style={{ fontSize: 13, color: theme.colors.critical }} onPress={() => setConfirming({ kind: "link", id: l.id, label })}>
                    Revoke
                  </Text>
                )}
              </View>
              {isConfirming && (
                <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
                    Revoke the public link for &quot;{label}&quot;? Anyone using it loses access immediately.
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button variant="critical" onPress={confirmRevoke} loading={revoking}>
                        Revoke
                      </Button>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button variant="secondary" onPress={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </View>
                  </View>
                </View>
              )}
            </Card>
          );
        })}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Shared with me</Text>
        {withMe && withMe.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Nothing shared with you yet.</Text>}
        {withMe?.map((g) => (
          <Card key={g.id}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{g.resourceLabel ?? g.resourceTypeLabel}</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              From {g.granterEmail} — {RIGHT_LABELS[g.right]}, {expiryText(g.expiresAt)}
            </Text>
          </Card>
        ))}
      </View>
    </Screen>
  );
}
