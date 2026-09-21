import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/lib/auth-context";
import { I18nProvider } from "@/lib/i18n-provider";
import { AppThemeProvider, useAppTheme } from "@/lib/theme-context";
import { BiometricLockProvider } from "@/lib/biometric-lock-context";
import { FinancialPrivacyProvider } from "@/lib/financial-privacy-context";
import { PersonalizationProvider } from "@/lib/use-personalization";
import { LockGate } from "@/components/lock-gate";
import { DeletionPendingGate } from "@/components/deletion-pending-gate";
import { PushRegistration } from "@/components/push-registration";
import { PushNavigation } from "@/components/push-navigation";
import { NotificationCaptureDrain } from "@/components/notification-capture-drain";
import { AndroidShareIntentDrain } from "@/components/android-share-intent-drain";
import { OfflineMutationQueueDrain } from "@/components/offline-mutation-queue-drain";
// Side-effect import only — registers the LOC-002 background geofence-event TaskManager.defineTask
// handler (geofencing.native.ts) at module load, which the OS requires to be able to find even after the
// app process was killed and relaunched purely to handle a geofence crossing. The web build resolves to
// geofencing.web.ts's no-op stub instead (see that file's doc comment) — importing it there is harmless.
import "@/lib/geofencing";

/**
 * Proof that the device is running a freshly loaded bundle, emitted once per bundle evaluation.
 *
 * This exists because of a verification that lied. The Android harness only called `launchApp` when the
 * app was NOT already running, so a second run inherited whatever bundle the first one left in memory. A
 * Connections card's heading was deliberately changed to prove the mobile verifier could fail, and the
 * verifier reported 48 passed, 0 failed — against the OLD card, still rendered by the OLD bundle. Every
 * assertion in that run was true about code that was no longer on disk. That is the worst failure shape
 * this audit keeps finding: a green result that measured nothing.
 *
 * It goes to the log rather than into the view tree. The first attempt was a zero-size `accessible` View,
 * which never appeared: Android does not report a 0x0 node to the accessibility tree at all, so the
 * harness saw nothing and (correctly) refused. A log line has no layout, no theming and no chance of being
 * filtered out by a screen that happens to be scrolled elsewhere.
 *
 * The harness clears logcat, force-stops the app and relaunches; a stamp appearing after that point can
 * only have come from a fresh evaluation of the bundle now on disk. If none appears, the run is refused
 * rather than reported.
 *
 * Dev-only — `__DEV__` is false in any release build, so this never ships.
 */
if (__DEV__) {
  console.log(`veynlo-bundle-stamp:${Date.now()}`);
}

function ThemedStack() {
  const { theme } = useAppTheme();
  return (
    <>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <PushRegistration />
      <PushNavigation />
      <NotificationCaptureDrain />
      <AndroidShareIntentDrain />
      <OfflineMutationQueueDrain />
      <DeletionPendingGate>
        <LockGate>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bgCanvas } }} />
        </LockGate>
      </DeletionPendingGate>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppThemeProvider>
          <AuthProvider>
            <I18nProvider>
              <BiometricLockProvider>
                {/* Above FinancialPrivacyProvider, which reads the preference it owns. One copy for the
                    whole app: while every caller held its own, toggling financial privacy mode updated the
                    privacy screen and left the provider that does the masking on its startup value. */}
                <PersonalizationProvider>
                  <FinancialPrivacyProvider>
                    <ThemedStack />
                  </FinancialPrivacyProvider>
                </PersonalizationProvider>
              </BiometricLockProvider>
            </I18nProvider>
          </AuthProvider>
        </AppThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
