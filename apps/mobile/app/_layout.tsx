import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "@/lib/auth-context";
import { AppThemeProvider, useAppTheme } from "@/lib/theme-context";
import { BiometricLockProvider } from "@/lib/biometric-lock-context";
import { LockGate } from "@/components/lock-gate";
import { PushRegistration } from "@/components/push-registration";

function ThemedStack() {
  const { theme } = useAppTheme();
  return (
    <>
      <StatusBar style={theme.mode === "dark" ? "light" : "dark"} />
      <PushRegistration />
      <LockGate>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.colors.bgCanvas } }} />
      </LockGate>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppThemeProvider>
          <AuthProvider>
            <BiometricLockProvider>
              <ThemedStack />
            </BiometricLockProvider>
          </AuthProvider>
        </AppThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
