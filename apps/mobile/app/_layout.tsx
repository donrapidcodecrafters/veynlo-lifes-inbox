import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/lib/auth-context";
import { I18nProvider } from "@/lib/i18n-provider";
import { AppThemeProvider, useAppTheme } from "@/lib/theme-context";
import { BiometricLockProvider } from "@/lib/biometric-lock-context";
import { FinancialPrivacyProvider } from "@/lib/financial-privacy-context";
import { LockGate } from "@/components/lock-gate";
import { DeletionPendingGate } from "@/components/deletion-pending-gate";
import { PushRegistration } from "@/components/push-registration";
import { NotificationCaptureDrain } from "@/components/notification-capture-drain";
import { AndroidShareIntentDrain } from "@/components/android-share-intent-drain";
import { OfflineMutationQueueDrain } from "@/components/offline-mutation-queue-drain";
// Side-effect import only — registers the LOC-002 background geofence-event TaskManager.defineTask
// handler (geofencing.native.ts) at module load, which the OS requires to be able to find even after the
// app process was killed and relaunched purely to handle a geofence crossing. The web build resolves to
// geofencing.web.ts's no-op stub instead (see that file's doc comment) — importing it there is harmless.
import "@/lib/geofencing";

function ThemedStack() {
  const { theme } = useAppTheme();
  return (
    <>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <PushRegistration />
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
                <FinancialPrivacyProvider>
                  <ThemedStack />
                </FinancialPrivacyProvider>
              </BiometricLockProvider>
            </I18nProvider>
          </AuthProvider>
        </AppThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
