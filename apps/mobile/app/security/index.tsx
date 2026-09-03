import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { passkeyAvailable, isPasskeySupported, registerPasskey } from "@/lib/passkey";
import type { RegistrationOptionsJSON } from "@/lib/passkey.types";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";
import { Platform } from "react-native";

interface PasskeyRow {
  id: string;
  label: string | null;
  deviceType: string | null;
  backedUp: boolean | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface SessionRow {
  id: string;
  deviceId: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  platform: string | null;
  displayName: string | null;
  isCurrent: boolean;
}

const PLATFORM_LABEL: Record<string, string> = {
  web: "Web browser",
  ios: "iPhone/iPad",
  android: "Android",
  macos: "Mac",
  windows: "Windows",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** §AUTH-001 "Device list and session activity are visible in settings" — mirrors the web
 * /settings/security page. Was missing on mobile entirely: the backend's `/v1/auth/sessions`,
 * revoke-one, and sign-out-everywhere endpoints existed and were exercised by the web client, but no
 * mobile screen ever called them, so a mobile user had no way to see or revoke another device's session. */
export default function SecurityScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const { signOut } = useAuth();
  const [sessions, setSessions] = useState<SessionRow[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [signingOutEverywhere, setSigningOutEverywhere] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Found live: this screen's only destructive-confirm used RN's `Alert.alert`, but react-native-web's
  // `Alert.alert` is a permanent no-op stub (confirmed live — tapping "Sign out everywhere" under
  // `expo start --web` did nothing at all: no dialog, no error, no navigation, no API call). Every other
  // destructive-confirm flow already in this app (automations.tsx's confirmingDeleteId, list/[id].tsx's
  // confirmingDeleteList, saved-item's delete) uses inline Card/Pressable state instead of Alert for
  // exactly this reason — matching that convention here instead of Alert.
  const [confirmingSignOutEverywhere, setConfirmingSignOutEverywhere] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | undefined>(undefined);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [removingPasskeyId, setRemovingPasskeyId] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .get<SessionRow[]>("/v1/auth/sessions")
      .then(setSessions)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Couldn't load your sessions. Please try again."));
  }, []);

  const loadPasskeys = useCallback(() => {
    api.get<PasskeyRow[]>("/v1/auth/passkeys").then(setPasskeys).catch(() => setPasskeys([]));
  }, []);

  useEffect(() => {
    load();
    if (passkeyAvailable) loadPasskeys();
  }, [load, loadPasskeys]);

  /** AUTH-001 "create passkey" — UNVERIFIED ON A REAL DEVICE, see docs/PHASE2_PENDING_CREDENTIALS.md. */
  async function addPasskey() {
    setAddingPasskey(true);
    setPasskeyError(null);
    try {
      const { options, challengeToken } = await api.post<{ options: RegistrationOptionsJSON; challengeToken: string }>("/v1/auth/passkeys/registration-options");
      const ceremony = await registerPasskey(options);
      if (ceremony.status === "cancelled") return;
      if (ceremony.status === "error") throw new Error(ceremony.message);
      await api.post("/v1/auth/passkeys/registration-verify", {
        response: ceremony.response,
        challengeToken,
        label: Platform.OS === "ios" ? "iPhone/iPad" : "Android device",
      });
      loadPasskeys();
    } catch (err) {
      setPasskeyError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Couldn't add that passkey. Please try again.");
    } finally {
      setAddingPasskey(false);
    }
  }

  async function removePasskey(id: string) {
    setRemovingPasskeyId(id);
    setPasskeyError(null);
    try {
      await api.delete(`/v1/auth/passkeys/${id}`);
      loadPasskeys();
    } catch (err) {
      setPasskeyError(err instanceof ApiError ? err.message : "Couldn't remove that passkey. Please try again.");
    } finally {
      setRemovingPasskeyId(null);
    }
  }

  const active = (sessions ?? [])
    .filter((s) => !s.revokedAt)
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime());

  async function revoke(sessionId: string) {
    setRevokingId(sessionId);
    setActionError(null);
    try {
      await api.post(`/v1/auth/sessions/${sessionId}/revoke`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't sign out that device. Please try again.");
    } finally {
      setRevokingId(null);
    }
  }

  async function signOutEverywhere() {
    setSigningOutEverywhere(true);
    setActionError(null);
    try {
      await api.post("/v1/auth/sign-out-everywhere");
      await signOut();
      router.replace("/sign-in");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSigningOutEverywhere(false);
      setConfirmingSignOutEverywhere(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Security" subtitle="Everywhere you're currently signed in. Sign out of a device you don't recognize." />

      {loadError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{loadError}</Text>}
      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {!sessions && !loadError && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Loading…</Text>}
      {sessions && active.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No active sessions.</Text>}

      {active.length > 0 && (
        <View style={{ gap: 8 }}>
          {active.map((s) => (
            <Card key={s.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                    {s.displayName || (s.platform && PLATFORM_LABEL[s.platform]) || "Unknown device"}
                  </Text>
                  {s.isCurrent && <Badge tone="brand">This device</Badge>}
                </View>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>Last active {formatWhen(s.lastSeenAt)}</Text>
              </View>
              <View style={{ minWidth: 90 }}>
                <Button variant="secondary" loading={revokingId === s.id} onPress={() => revoke(s.id)}>
                  Sign out
                </Button>
              </View>
            </Card>
          ))}
        </View>
      )}

      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row" }}>
          <Badge tone="warning">All devices</Badge>
        </View>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Sign out everywhere at once, including this device.</Text>
        {!confirmingSignOutEverywhere && (
          <Button variant="critical" onPress={() => setConfirmingSignOutEverywhere(true)}>
            Sign out everywhere
          </Button>
        )}
        {confirmingSignOutEverywhere && (
          <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
              Sign out everywhere? This signs you out of every device, including this one.
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button variant="critical" loading={signingOutEverywhere} onPress={signOutEverywhere}>
                  Sign out everywhere
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setConfirmingSignOutEverywhere(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </View>

      {/* AUTH-001 "create passkey" / "add/remove sign-in method" — UNVERIFIED ON A REAL DEVICE, see
          docs/PHASE2_PENDING_CREDENTIALS.md. Only rendered when `passkeyAvailable` (native builds only —
          see passkey.web.ts) AND this OS version actually supports passkeys. */}
      {passkeyAvailable && isPasskeySupported() && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 16, fontWeight: "700", color: theme.colors.textPrimary }}>Passkeys</Text>
          {/* Android has no Face ID/Touch ID (Apple's branding) — its passkey/WebAuthn platform
              authenticator prompt is Google's BiometricPrompt (fingerprint/face unlock/device credential),
              so this copy is literally wrong there. Same ios/else split this screen's own device-label
              ternary above (line ~103) already uses. */}
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            {Platform.OS === "ios"
              ? "Sign in with Face ID, Touch ID, or your device's screen lock — no password to remember or steal."
              : "Sign in with your fingerprint or face unlock, or your device's screen lock — no password to remember or steal."}
          </Text>

          {passkeyError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{passkeyError}</Text>}

          {passkeys && passkeys.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No passkeys yet.</Text>}

          {passkeys && passkeys.length > 0 && (
            <View style={{ gap: 8 }}>
              {passkeys.map((p) => (
                <Card key={p.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.label || "Passkey"}</Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
                      {p.lastUsedAt ? `Last used ${formatWhen(p.lastUsedAt)}` : `Added ${formatWhen(p.createdAt)}`}
                    </Text>
                  </View>
                  <View style={{ minWidth: 90 }}>
                    <Button variant="secondary" loading={removingPasskeyId === p.id} onPress={() => removePasskey(p.id)}>
                      Remove
                    </Button>
                  </View>
                </Card>
              ))}
            </View>
          )}

          <Button variant="secondary" loading={addingPasskey} onPress={addPasskey}>
            Add a passkey
          </Button>
        </View>
      )}
    </Screen>
  );
}
