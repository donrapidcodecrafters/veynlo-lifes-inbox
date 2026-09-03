import { useCallback, useEffect, useState } from "react";
import { Platform, Text, View } from "react-native";
import Constants from "expo-constants";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

// Mirrors api-client.ts's own DEFAULT_API_BASE_URL fallback pattern — the web app's `/share/:token` page
// is what a recipient actually needs to open, and this is the only client-side reference to its base URL
// this app has ever needed.
const DEFAULT_WEB_APP_URL = Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";
const WEB_APP_URL = Constants.expoConfig?.extra?.webAppUrl ?? process.env.EXPO_PUBLIC_WEB_APP_URL ?? DEFAULT_WEB_APP_URL;

type ResourceGrantRight = "view" | "edit" | "manage";

interface ResourceGrant {
  grant: { id: string; expiresAt: string | null; right?: ResourceGrantRight; message?: string | null };
  granteeEmail: string;
}
interface ShareLink {
  id: string;
  hasPasscode: boolean;
}

/** §35 SHARE-007 "access history" — mirrors apps/web's own AccessEvent shape. */
interface AccessEvent {
  id: string;
  accessMethod: "grant" | "share_link";
  accessedAt: string;
  accessedByEmail: string | null;
}

const RIGHT_LABELS: Record<ResourceGrantRight, string> = { view: "Can view", edit: "Can edit", manage: "Can manage" };

/** SHARE-001 "preview exactly what recipient will see" — same generic, resource-agnostic renderer as
 * apps/web's own ShareResourcePanel (see that file's own doc comment on why this stays generic). */
function PreviewValue({ value, theme }: { value: unknown; theme: ReturnType<typeof useAppTheme>["theme"] }) {
  if (value == null) return <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>—</Text>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>None</Text>;
    return (
      <View style={{ gap: 4 }}>
        {value.map((item, i) => (
          <View key={i} style={{ paddingLeft: 8 }}>
            {typeof item === "object" && item !== null ? (
              <PreviewObject value={item as Record<string, unknown>} theme={theme} />
            ) : (
              <Text style={{ fontSize: 12, color: theme.colors.textPrimary }}>• {String(item)}</Text>
            )}
          </View>
        ))}
      </View>
    );
  }
  if (typeof value === "object") return <PreviewObject value={value as Record<string, unknown>} theme={theme} />;
  return <Text style={{ fontSize: 12, color: theme.colors.textPrimary }}>{String(value)}</Text>;
}

function PreviewObject({ value, theme }: { value: Record<string, unknown>; theme: ReturnType<typeof useAppTheme>["theme"] }) {
  return (
    <View style={{ gap: 4 }}>
      {Object.entries(value).map(([key, v]) => (
        <View key={key} style={{ flexDirection: "row", gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textSecondary }}>{key}:</Text>
          <View style={{ flex: 1 }}>
            <PreviewValue value={v} theme={theme} />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — direct grants to another Veynlo account,
 * and passcode-optional public links. Generalized off documents.tsx's original `ShareDocumentPanel` (same
 * component, just parameterized by resource type now that SharingService backs lists/purchases/
 * properties/vehicles too — see services/api/src/modules/sharing/sharing.service.ts's own doc comment).
 * Mirrors apps/web's own `ShareResourcePanel` (apps/web/src/components/sharing/share-resource-panel.tsx).
 *
 * `collectionPath` is the resource's own API collection, e.g. "/v1/documents", "/v1/lists",
 * "/v1/purchases", "/v1/properties", "/v1/vehicles" — every one exposes the exact same `:id/grants` /
 * `:id/share-links` / `grants/:grantId` / `share-links/:linkId` shape (see each controller's own sharing
 * routes), so this component never needs to know what kind of resource it's sharing, only where its
 * collection lives.
 *
 * `enableShareLinks`/`enablePreview` default true for every resource that DOES expose the full
 * grants+share-links+share-preview surface above. §14 People (PEO-001) only ever grew the direct-grant
 * half of that surface (see PeopleController — `:id/grants` only, no `:id/share-links` or
 * `:id/share-preview`), so a "person" caller passes both false to skip the calls and UI this component
 * would otherwise 404 on.
 */
export function ShareResourcePanel({
  resourceId,
  collectionPath,
  resourceLabel,
  enableShareLinks = true,
  enablePreview = true,
}: {
  resourceId: string;
  collectionPath: string;
  resourceLabel: string;
  enableShareLinks?: boolean;
  enablePreview?: boolean;
}) {
  const { theme } = useAppTheme();
  const [grants, setGrants] = useState<ResourceGrant[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [accessEvents, setAccessEvents] = useState<AccessEvent[]>([]);
  const [email, setEmail] = useState("");
  // SHARE-001 "Set view/edit/manage" — mirrors apps/web's own default; chip buttons rather than a native
  // picker, same reasoning as the expiry chips just below.
  const [right, setRight] = useState<ResourceGrantRight>("view");
  // SHARE-001 "optional message" — mirrors apps/web's own note field.
  const [message, setMessage] = useState("");
  // SHARE-001 "expiration" — mirrors apps/web's own select; null means "until revoked". Chip-style buttons
  // rather than a native `<select>`, same reasoning as CAL-002's destination picker on this platform.
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [creatingLink, setCreatingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [newLinkUrl, setNewLinkUrl] = useState<string | null>(null);
  // SHARE-001 "preview exactly what recipient will see" — same reasoning as apps/web's own.
  const [preview, setPreview] = useState<unknown>(undefined);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Same reasoning as the original ShareDocumentPanel's own note (see documents.tsx history): a transient
  // network failure here with no try/catch throws an unhandled promise rejection straight out of this
  // effect, which React Native Web surfaces as a full-screen "Uncaught Error" dev overlay that blocks the
  // entire app, not just this panel.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setGrants(await api.get<ResourceGrant[]>(`${collectionPath}/${resourceId}/grants`));
      if (enableShareLinks) setLinks(await api.get<ShareLink[]>(`${collectionPath}/${resourceId}/share-links`));
      setAccessEvents(await api.get<AccessEvent[]>(`${collectionPath}/${resourceId}/access-log`));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load sharing info. Please try again.");
    }
  }, [collectionPath, resourceId, enableShareLinks]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadPreview() {
    setPreviewOpen(true);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      setPreview(await api.get(`${collectionPath}/${resourceId}/share-preview`));
    } catch (err) {
      setPreviewError(err instanceof ApiError ? err.message : "Couldn't load a preview. Please try again.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function addGrant() {
    setGranting(true);
    setGrantError(null);
    try {
      await api.post(`${collectionPath}/${resourceId}/grants`, {
        granteeEmail: email,
        right,
        expiresInDays: expiresInDays ?? undefined,
        message: message.trim() || undefined,
      });
      setEmail("");
      setRight("view");
      setMessage("");
      setExpiresInDays(null);
      await load();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't share with that email. Please try again.");
    } finally {
      setGranting(false);
    }
  }

  async function revokeGrant(grantId: string) {
    try {
      await api.delete(`${collectionPath}/grants/${grantId}`);
      await load();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't remove that. Please try again.");
    }
  }

  async function addLink() {
    setCreatingLink(true);
    setLinkError(null);
    setNewLinkUrl(null);
    try {
      const { token } = await api.post<{ id: string; token: string }>(`${collectionPath}/${resourceId}/share-links`, {
        passcode: passcode.trim() || undefined,
      });
      setNewLinkUrl(`${WEB_APP_URL}/share/${token}`);
      setPasscode("");
      await load();
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : "Couldn't create a share link. Please try again.");
    } finally {
      setCreatingLink(false);
    }
  }

  async function revokeLink(linkId: string) {
    try {
      await api.delete(`${collectionPath}/share-links/${linkId}`);
      setNewLinkUrl(null);
      await load();
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : "Couldn't revoke that link. Please try again.");
    }
  }

  return (
    <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
      {loadError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{loadError}</Text>}

      {enablePreview && (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, flex: 1, marginRight: 8 }}>See exactly what a recipient would get before you share.</Text>
          <Button variant="secondary" onPress={loadPreview}>
            Preview
          </Button>
        </View>
      )}
      {enablePreview && previewOpen && (
        <View style={{ gap: 6, borderWidth: 1, borderColor: theme.colors.borderDefault, borderRadius: 10, padding: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textSecondary }}>Recipient preview</Text>
            <Text
              style={{ fontSize: 12, color: theme.colors.textTertiary }}
              onPress={() => setPreviewOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close preview"
            >
              Close
            </Text>
          </View>
          {previewLoading && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Loading…</Text>}
          {previewError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{previewError}</Text>}
          {!previewLoading && !previewError && preview !== undefined && <PreviewValue value={preview} theme={theme} />}
        </View>
      )}

      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textSecondary }}>Share with someone&apos;s Veynlo account</Text>
        {/* HH-002 "Changing privacy explains consequences before saving" — mirrors apps/web's own copy. */}
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
          They&apos;ll get {RIGHT_LABELS[right].toLowerCase()} access to this {resourceLabel} until you remove them below.
        </Text>
        {grants.map((g) => (
          <View key={g.grant.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <View>
              <Text style={{ fontSize: 12, color: theme.colors.textPrimary }}>{g.granteeEmail}</Text>
              <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                {RIGHT_LABELS[g.grant.right ?? "view"]} — {g.grant.expiresAt ? `expires ${new Date(g.grant.expiresAt).toLocaleDateString()}` : "until revoked"}
              </Text>
              {g.grant.message && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Note: {g.grant.message}</Text>}
            </View>
            <Text
              style={{ fontSize: 12, color: theme.colors.critical }}
              onPress={() => revokeGrant(g.grant.id)}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${g.granteeEmail}'s access`}
            >
              Remove
            </Text>
          </View>
        ))}
        <TextField label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <View style={{ flexDirection: "row", gap: 6 }}>
          {(["view", "edit", "manage"] as const).map((r) => (
            <Text
              key={r}
              onPress={() => setRight(r)}
              accessibilityRole="button"
              accessibilityState={{ selected: right === r }}
              style={{
                fontSize: 11,
                paddingVertical: 4,
                paddingHorizontal: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: right === r ? theme.colors.brandDefault : theme.colors.borderSubtle,
                color: right === r ? theme.colors.brandDefault : theme.colors.textTertiary,
              }}
              maxFontSizeMultiplier={1.6}
            >
              {RIGHT_LABELS[r]}
            </Text>
          ))}
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {[
            { label: "Until revoked", value: null },
            { label: "7 days", value: 7 },
            { label: "30 days", value: 30 },
            { label: "90 days", value: 90 },
          ].map((opt) => (
            <Text
              key={opt.label}
              onPress={() => setExpiresInDays(opt.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: expiresInDays === opt.value }}
              style={{
                fontSize: 11,
                paddingVertical: 4,
                paddingHorizontal: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: expiresInDays === opt.value ? theme.colors.brandDefault : theme.colors.borderSubtle,
                color: expiresInDays === opt.value ? theme.colors.brandDefault : theme.colors.textTertiary,
              }}
              maxFontSizeMultiplier={1.6}
            >
              {opt.label}
            </Text>
          ))}
        </View>
        <TextField label="Optional note to them" value={message} onChangeText={(t) => setMessage(t.slice(0, 500))} />
        {grantError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{grantError}</Text>}
        <Button variant="secondary" onPress={addGrant} loading={granting} disabled={!email.trim()}>
          Share
        </Button>
      </View>

      {enableShareLinks && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textSecondary }}>Public link</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            {/* "items" not "{resourceLabel}s" — naively pluralizing the noun breaks for "property" (→
                "propertys"); mirrors apps/web's ShareResourcePanel, which made the same call. */}
            Anyone with the link can view this {resourceLabel} without a Veynlo account — treat it like handing over a copy. Highly sensitive items
            can&apos;t use a public link.
          </Text>
          {links.map((l) => (
            <View key={l.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{l.hasPasscode ? "Passcode-protected link" : "Open link"}</Text>
              <Text
                style={{ fontSize: 12, color: theme.colors.critical }}
                onPress={() => revokeLink(l.id)}
                accessibilityRole="button"
                accessibilityLabel="Revoke this share link"
              >
                Revoke
              </Text>
            </View>
          ))}
          <TextField label="Optional passcode" value={passcode} onChangeText={setPasscode} autoCapitalize="none" />
          {linkError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{linkError}</Text>}
          <Button variant="secondary" onPress={addLink} loading={creatingLink}>
            Create link
          </Button>
          {newLinkUrl && (
            <Text style={{ fontSize: 12, color: theme.colors.positiveSubtleText }}>{newLinkUrl} — copy this now, it won&apos;t be shown again.</Text>
          )}
        </View>
      )}

      {/* §35 SHARE-007 "access history" — mirrors apps/web's own ShareResourcePanel section. */}
      {accessEvents.length > 0 && (
        <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textSecondary }}>Who&apos;s viewed this</Text>
          {accessEvents.map((e) => (
            <View key={e.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 12, color: theme.colors.textPrimary }}>{e.accessedByEmail ?? "Someone via the public link"}</Text>
              <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>{new Date(e.accessedAt).toLocaleString()}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
