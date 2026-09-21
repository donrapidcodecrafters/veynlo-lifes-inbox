import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState, Platform, type AppStateStatus } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { biometricLockStore } from "./biometric-lock-store";

interface BiometricLockContextValue {
  ready: boolean;
  /** Hardware present AND the device has Face ID/Touch ID/a passcode actually enrolled. */
  supported: boolean;
  enabled: boolean;
  isLocked: boolean;
  setEnabled: (next: boolean) => Promise<{ ok: boolean; error?: string }>;
  unlock: () => Promise<boolean>;
}

const BiometricLockContext = createContext<BiometricLockContextValue | null>(null);

/**
 * Device-local app lock (§Account/security — Face ID/Touch ID app unlock). Deliberately not backed by
 * the `devices.biometricLockEnabled` DB column — that column belongs to a separate, unbuilt
 * server-tracked device-management feature; this is a per-installation client preference, same tier as
 * theme (see theme-store.ts) and stored the same way.
 */
export function BiometricLockProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [isLocked, setIsLocked] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    (async () => {
      let isSupported = false;
      if (Platform.OS !== "web") {
        const [hasHardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
        isSupported = hasHardware && enrolled;
      }
      const stored = await biometricLockStore.get();
      setSupported(isSupported);
      // A preference saved on a device that later lost its enrollment (Face ID reset, etc.) shouldn't lock
      // the user out with no way back in — only actually lock when biometrics are still usable.
      const effectiveEnabled = stored && isSupported;
      setEnabledState(effectiveEnabled);
      setIsLocked(effectiveEnabled);
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (appState.current === "active" && next !== "active" && enabled) {
        setIsLocked(true);
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, [enabled]);

  async function setEnabled(next: boolean): Promise<{ ok: boolean; error?: string }> {
    if (next && !supported) {
      // Android has no Face ID/Touch ID (Apple's branding) — its system prompt is Google's BiometricPrompt
      // (fingerprint/face unlock/device credential), so this copy is literally wrong there. Same ios/else
      // split oauth-sign-in-buttons.tsx's `platform` and security/index.tsx's device-label ternary already
      // use for the same reason.
      return {
        ok: false,
        error:
          Platform.OS === "ios"
            ? "Set up Face ID, Touch ID, or a device passcode first, then try again."
            : "Set up your fingerprint or face unlock, or a device passcode first, then try again.",
      };
    }
    if (next) {
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Confirm to turn on app lock" });
      if (!result.success) return { ok: false, error: "Couldn't verify — app lock wasn't turned on." };
    }
    await biometricLockStore.set(next);
    setEnabledState(next);
    return { ok: true };
  }

  async function unlock(): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Veynlo" });
    if (result.success) setIsLocked(false);
    return result.success;
  }

  const value = useMemo(
    () => ({ ready, supported, enabled, isLocked, setEnabled, unlock }),
    // `setEnabled`/`unlock` are redeclared each render; depending on them would rebuild this context
    // value every render and re-render every consumer, which is what this useMemo exists to prevent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready, supported, enabled, isLocked],
  );

  return <BiometricLockContext.Provider value={value}>{children}</BiometricLockContext.Provider>;
}

export function useBiometricLock(): BiometricLockContextValue {
  const ctx = useContext(BiometricLockContext);
  if (!ctx) throw new Error("useBiometricLock must be used within BiometricLockProvider");
  return ctx;
}
