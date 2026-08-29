import { useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { useBiometricLock } from "@/lib/biometric-lock-context";
import type { ThemeMode } from "@/lib/theme";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { mode, setMode, theme } = useAppTheme();
  const { ready: lockReady, supported: lockSupported, enabled: lockEnabled, setEnabled: setLockEnabled } = useBiometricLock();
  const [lockError, setLockError] = useState<string | null>(null);

  async function onToggleLock(next: boolean) {
    setLockError(null);
    const result = await setLockEnabled(next);
    if (!result.ok) setLockError(result.error ?? "Something went wrong.");
  }

  async function onSignOut() {
    await signOut();
    router.replace("/sign-in");
  }

  const [showDeleteForm, setShowDeleteForm] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function onDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.post("/v1/auth/delete-account", { password: deletePassword });
      await signOut();
      router.replace("/sign-in");
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setDeleting(false);
    }
  }

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Settings</Text>
      </View>

      <Card style={{ gap: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{user?.displayName}</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{user?.email}</Text>
      </Card>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
          Appearance
        </Text>
        <Card style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.bgSubtle }}>
          {THEME_OPTIONS.map((opt) => {
            const active = mode === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setMode(opt.value)}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: theme.radius.sm,
                  backgroundColor: active ? theme.colors.bgSurface : "transparent",
                  alignItems: "center",
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Security</Text>
        <Card style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>App lock</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                {lockReady && !lockSupported
                  ? "Set up Face ID, Touch ID, or a device passcode to use this."
                  : "Require Face ID, Touch ID, or your passcode to open Veynlo."}
              </Text>
            </View>
            <Switch
              value={lockEnabled}
              onValueChange={onToggleLock}
              disabled={!lockReady || !lockSupported}
              trackColor={{ true: theme.colors.brandDefault }}
            />
          </View>
          {lockError && <Text style={{ fontSize: 13, color: theme.colors.critical, marginTop: 6 }}>{lockError}</Text>}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Data</Text>
        <Button variant="secondary" onPress={() => router.push("/privacy")}>
          Privacy
        </Button>
        <Button variant="secondary" onPress={() => router.push("/connections")}>
          Connections
        </Button>
        <Button variant="secondary" onPress={() => router.push("/data-export")}>
          Export your data
        </Button>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Billing</Text>
        <Button variant="secondary" onPress={() => router.push("/billing")}>
          Plan &amp; billing
        </Button>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Notifications</Text>
        <Button variant="secondary" onPress={() => router.push("/notifications")}>
          Notification history
        </Button>
      </View>

      <Button variant="secondary" onPress={onSignOut}>
        Sign out
      </Button>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
          Danger zone
        </Text>
        <Card style={{ gap: 12 }}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Delete account</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
              Permanently deletes your account and everything in it. This can&apos;t be undone.
            </Text>
          </View>
          {!showDeleteForm ? (
            <Button variant="critical" onPress={() => setShowDeleteForm(true)}>
              Delete account
            </Button>
          ) : (
            <View style={{ gap: 12 }}>
              <TextField
                label="Confirm your password"
                value={deletePassword}
                onChangeText={setDeletePassword}
                secureTextEntry
                autoComplete="password"
              />
              {deleteError && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{deleteError}</Text>}
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button variant="critical" onPress={onDeleteAccount} loading={deleting}>
                    Permanently delete
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setShowDeleteForm(false);
                      setDeletePassword("");
                      setDeleteError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </View>
              </View>
            </View>
          )}
        </Card>
      </View>
    </Screen>
  );
}
