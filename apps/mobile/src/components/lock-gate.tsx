import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useAuth } from "@/lib/auth-context";
import { useBiometricLock } from "@/lib/biometric-lock-context";
import { useAppTheme } from "@/lib/theme-context";
import { Button } from "./button";

/** Gates authenticated screens behind Face ID/Touch ID when the user has turned on app lock. Signed-out users pass through untouched — the sign-in screen is their gate. */
export function LockGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { ready, isLocked, unlock } = useBiometricLock();
  const { theme } = useAppTheme();

  if (!user || !ready || !isLocked) return <>{children}</>;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bgCanvas, alignItems: "center", justifyContent: "center", gap: 20, padding: 24 }}>
      <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>Veynlo is locked</Text>
      <Text style={{ fontSize: 14, color: theme.colors.textTertiary, textAlign: "center" }}>
        Unlock with Face ID, Touch ID, or your device passcode to continue.
      </Text>
      <View style={{ width: "100%", maxWidth: 280 }}>
        <Button onPress={unlock}>Unlock</Button>
      </View>
    </View>
  );
}
