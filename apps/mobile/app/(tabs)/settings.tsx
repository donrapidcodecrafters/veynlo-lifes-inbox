import { useEffect, useState } from "react";
import { Platform, Pressable, Switch, Text, View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { useBiometricLock } from "@/lib/biometric-lock-context";
import { isNotificationCaptureFeatureEnabled } from "@/lib/notification-capture";
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

const INTENSITY_OPTIONS: Array<{ value: "quiet" | "balanced" | "proactive"; label: string }> = [
  { value: "quiet", label: "Quiet" },
  { value: "balanced", label: "Balanced" },
  { value: "proactive", label: "Proactive" },
];

// §NOT-001/002/005/006/008 — mirrors apps/web's settings page notification section (same
// /v1/notification-preferences GET/PUT contract). This screen previously had zero notification
// preference controls at all — not even the intensity/brief toggles web already exposed — so a mobile
// user had no in-app way to mute, set quiet hours, or turn off briefs; the only reachable notification
// UI here was "Notification history" (read-only). Wired up the same fields web already supports.
interface NotificationPreferences {
  intensity: "quiet" | "balanced" | "proactive";
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  criticalOverridesQuietHours: boolean;
  dailyBriefEnabled: boolean;
  weeklyBriefEnabled: boolean;
  sensitivePreviewsEnabled: boolean;
}

export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { t } = useTranslation("translation", { keyPrefix: "settings" });
  const { mode, setMode, theme } = useAppTheme();
  const { ready: lockReady, supported: lockSupported, enabled: lockEnabled, setEnabled: setLockEnabled } = useBiometricLock();
  const [lockError, setLockError] = useState<string | null>(null);
  const [messageCaptureAvailable, setMessageCaptureAvailable] = useState(false);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);

  useEffect(() => {
    isNotificationCaptureFeatureEnabled().then(setMessageCaptureAvailable);
  }, []);

  useEffect(() => {
    api.get<NotificationPreferences>("/v1/notification-preferences").then(setPrefs).catch(() => {});
  }, []);

  // Optimistic update, same pattern as web's settings page: reflect the change immediately, then
  // reconcile with whatever the server actually persisted (e.g. a validation-rejected quiet-hours string).
  async function updatePrefs(patch: Partial<NotificationPreferences>) {
    setPrefs((prev) => (prev ? { ...prev, ...patch } : prev));
    const updated = await api.put<NotificationPreferences>("/v1/notification-preferences", patch);
    setPrefs(updated);
  }

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
  // Found live: submitting with an empty password 400s with a Zod fieldErrors.password entry, but this
  // showed only the generic "Request body failed validation." — the exact unhelpful-message gap
  // sign-in.tsx/sign-up.tsx already fixed for their own forms (see those files' identical comments),
  // missed here. Falls back to the generic message when the server didn't send field-level detail (e.g. a
  // genuinely wrong password, which has no fieldErrors of its own).
  const [deleteFieldErrors, setDeleteFieldErrors] = useState<Record<string, string[]>>({});
  const [deleting, setDeleting] = useState(false);

  async function onDeleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    setDeleteFieldErrors({});
    try {
      await api.post("/v1/auth/delete-account", { password: deletePassword });
      await signOut();
      router.replace("/sign-in");
    } catch (err) {
      if (err instanceof ApiError) {
        setDeleteFieldErrors(err.fieldErrors ?? {});
        if (!err.fieldErrors || Object.keys(err.fieldErrors).length === 0) setDeleteError(err.message);
      } else {
        setDeleteError(t("deleteAccount.genericError"));
      }
      setDeleting(false);
    }
  }

  return (
    <Screen>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }} accessibilityRole="header">
          {t("title")}
        </Text>
      </View>

      <Card style={{ gap: 2 }}>
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{user?.displayName}</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{user?.email}</Text>
      </Card>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
          {t("sections.appearance")}
        </Text>
        <Card style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.bgSubtle }}>
          {THEME_OPTIONS.map((opt) => {
            const active = mode === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => setMode(opt.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  flex: 1,
                  paddingVertical: 8,
                  borderRadius: theme.radius.sm,
                  backgroundColor: active ? theme.colors.bgSurface : "transparent",
                  alignItems: "center",
                }}
              >
                <Text
                  style={{ fontSize: 14, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}
                  maxFontSizeMultiplier={1.6}
                >
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </Card>
      </View>

      {/* §38.2 "Internationalization" — this screen's title, top section headings, sign-out, and
          delete-account subsection are wired to lib/i18n/en.json as the representative slice for
          this screen (mirrors apps/web's settings/page.tsx); the remaining section headings/row
          labels below are deliberately left as literals for now — see this app's lib/i18n/
          index.ts doc comment / the root README's "Internationalization" section for why a full
          sweep wasn't done in this pass. Extending this screen is the same t("settings.<key>")
          pattern already used above. */}
      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Personalization</Text>
        <Button variant="secondary" onPress={() => router.push("/personalization")}>
          Home layout, categories, naming &amp; Ask
        </Button>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Security</Text>
        <Card style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>App lock</Text>
              {/* Android has no Face ID/Touch ID (Apple's branding) — its system prompt is Google's
                  BiometricPrompt (fingerprint/face unlock/device credential), so this copy is literally
                  wrong there. Same ios/else split lock-gate.tsx and biometric-lock-context.tsx use. */}
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                {lockReady && !lockSupported
                  ? Platform.OS === "ios"
                    ? "Set up Face ID, Touch ID, or a device passcode to use this."
                    : "Set up your fingerprint or face unlock, or a device passcode to use this."
                  : Platform.OS === "ios"
                    ? "Require Face ID, Touch ID, or your passcode to open Veynlo."
                    : "Require your fingerprint or face unlock, or your passcode to open Veynlo."}
              </Text>
            </View>
            {/* `activeThumbColor` (RNW-only, not in RN's typed SwitchProps — harmlessly ignored on native)
                keeps the web preview's ON-state thumb on-brand: `trackColor` alone left the track purple
                but the thumb defaulting to react-native-web's hardcoded teal, confirmed live elsewhere
                on this screen (see list/[id].tsx, automations.tsx, privacy/index.tsx for the same fix). */}
            <Switch
              value={lockEnabled}
              onValueChange={onToggleLock}
              disabled={!lockReady || !lockSupported}
              accessibilityLabel="App lock"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>
          {lockError && <Text style={{ fontSize: 13, color: theme.colors.critical, marginTop: 6 }}>{lockError}</Text>}
        </Card>
        <Button variant="secondary" onPress={() => router.push("/security")}>
          Devices &amp; sessions
        </Button>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Family</Text>
        <Button variant="secondary" onPress={() => router.push("/household")}>
          Household
        </Button>
        <Button variant="secondary" onPress={() => router.push("/emergency-binder")}>
          Emergency binder
        </Button>
        <Button variant="secondary" onPress={() => router.push("/sharing")}>
          Sharing
        </Button>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Data</Text>
        <Button variant="secondary" onPress={() => router.push("/privacy")}>
          Privacy
        </Button>
        {messageCaptureAvailable && (
          <Button variant="secondary" onPress={() => router.push("/message-capture")}>
            Message capture
          </Button>
        )}
        <Button variant="secondary" onPress={() => router.push("/connections")}>
          Connections
        </Button>
        <Button variant="secondary" onPress={() => router.push("/automations")}>
          Automations
        </Button>
        <Button variant="secondary" onPress={() => router.push("/calendar-trust")}>
          Trusted reschedule senders
        </Button>
        <Button variant="secondary" onPress={() => router.push("/sender-rules")}>
          Sender rules
        </Button>
        <Button variant="secondary" onPress={() => router.push("/entities")}>
          What Veynlo knows
        </Button>
        <Button variant="secondary" onPress={() => router.push("/lists")}>
          Lists
        </Button>
        <Button variant="secondary" onPress={() => router.push("/places")}>
          Saved places
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
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>{t("sections.notifications")}</Text>
        <Card style={{ gap: 16 }}>
          <View style={{ gap: 8 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Intensity</Text>
            <View style={{ flexDirection: "row", gap: 6, padding: 6, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}>
              {INTENSITY_OPTIONS.map((opt) => {
                const active = (prefs?.intensity ?? "balanced") === opt.value;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => updatePrefs({ intensity: opt.value })}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={{
                      flex: 1,
                      paddingVertical: 8,
                      borderRadius: theme.radius.sm,
                      backgroundColor: active ? theme.colors.bgSurface : "transparent",
                      alignItems: "center",
                    }}
                  >
                    <Text
                      style={{ fontSize: 14, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}
                      maxFontSizeMultiplier={1.6}
                    >
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <View>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Quiet hours</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                No non-critical notifications during this window, in your local time. 24-hour "HH:MM", e.g. 22:00.
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
              <View style={{ flex: 1 }}>
                <TextField
                  label="Start"
                  placeholder="22:00"
                  value={prefs?.quietHoursStart ?? ""}
                  onChangeText={(v) => updatePrefs({ quietHoursStart: v || null })}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
              <View style={{ flex: 1 }}>
                <TextField
                  label="End"
                  placeholder="07:00"
                  value={prefs?.quietHoursEnd ?? ""}
                  onChangeText={(v) => updatePrefs({ quietHoursEnd: v || null })}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            </View>
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Let critical alerts break through quiet hours</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                A severe, time-sensitive issue (e.g. a confirmed flight cancellation or identity/insurance expiration) can still notify you during quiet hours. Off means nothing does.
              </Text>
            </View>
            <Switch
              value={prefs?.criticalOverridesQuietHours ?? true}
              onValueChange={(v) => updatePrefs({ criticalOverridesQuietHours: v })}
              accessibilityLabel="Let critical alerts break through quiet hours"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Daily brief</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>A short summary each morning.</Text>
            </View>
            <Switch
              value={prefs?.dailyBriefEnabled ?? true}
              onValueChange={(v) => updatePrefs({ dailyBriefEnabled: v })}
              accessibilityLabel="Daily brief"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Weekly brief</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>What's coming up next week.</Text>
            </View>
            <Switch
              value={prefs?.weeklyBriefEnabled ?? true}
              onValueChange={(v) => updatePrefs({ weeklyBriefEnabled: v })}
              accessibilityLabel="Weekly brief"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>

          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>Show details in notifications</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                When off, notifications say something needs attention without the specific amounts, dates, or descriptions.
              </Text>
            </View>
            <Switch
              value={prefs?.sensitivePreviewsEnabled ?? true}
              onValueChange={(v) => updatePrefs({ sensitivePreviewsEnabled: v })}
              accessibilityLabel="Show details in notifications"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>
        </Card>
        <Button variant="secondary" onPress={() => router.push("/notifications")}>
          Notification history
        </Button>
      </View>

      <Button variant="secondary" onPress={onSignOut}>
        {t("signOut")}
      </Button>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
          {t("sections.dangerZone")}
        </Text>
        <Card style={{ gap: 12 }}>
          <View style={{ gap: 2 }}>
            <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{t("deleteAccount.title")}</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{t("deleteAccount.description")}</Text>
          </View>
          {!showDeleteForm ? (
            <Button variant="critical" onPress={() => setShowDeleteForm(true)}>
              {t("deleteAccount.cta")}
            </Button>
          ) : (
            <View style={{ gap: 12 }}>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{t("deleteAccount.confirmNotice")}</Text>
              <TextField
                label={t("deleteAccount.confirmPasswordLabel")}
                value={deletePassword}
                onChangeText={setDeletePassword}
                secureTextEntry
                autoComplete="password"
                error={deleteFieldErrors.password?.[0]}
              />
              {deleteError && <Text style={{ color: theme.colors.critical, fontSize: 14 }}>{deleteError}</Text>}
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button variant="critical" onPress={onDeleteAccount} loading={deleting}>
                    {t("deleteAccount.submit")}
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    variant="secondary"
                    onPress={() => {
                      setShowDeleteForm(false);
                      setDeletePassword("");
                      setDeleteError(null);
                      setDeleteFieldErrors({});
                    }}
                  >
                    {t("deleteAccount.cancel")}
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
