import { createContext, useContext, useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api-client";
import { formatMoneyMinorUnits } from "@/lib/format";
import { usePersonalizationPreferences } from "@/lib/use-personalization";
import { useBiometricLock } from "@/lib/biometric-lock-context";

/** Same shared placeholder `@veynlo/core`'s `MASKED_AMOUNT_PLACEHOLDER` uses server-side and apps/web's
 * identical context uses client-side — kept as a plain literal here for the same reason apps/web's own
 * copy is: this app doesn't depend on the API-only package. */
const MASKED_AMOUNT = "••••";

type RevealResult = { ok: true } | { ok: false; needsPassword: boolean; error?: string };

interface FinancialPrivacyContextValue {
  enabled: boolean;
  masked: boolean;
  revealed: boolean;
  /** FIN-007 "biometric reveal option" — tries the device's own Face ID/Touch ID first (via
   * BiometricLockContext.unlock, which never touches the server at all) when it's set up on this device;
   * falls back to the same password step-up apps/web uses otherwise, or when a password is passed
   * explicitly (the password-prompt retry path after a first `requestReveal()` call comes back
   * `needsPassword: true`). */
  requestReveal: (password?: string) => Promise<RevealResult>;
  hide: () => void;
  maskMoney: (formatted: string | null) => string | null;
}

const FinancialPrivacyContext = createContext<FinancialPrivacyContextValue | null>(null);

export function FinancialPrivacyProvider({ children }: { children: ReactNode }) {
  const { data } = usePersonalizationPreferences();
  const { supported, unlock } = useBiometricLock();
  const [revealed, setRevealed] = useState(false);

  async function requestReveal(password?: string): Promise<RevealResult> {
    if (supported && !password) {
      const ok = await unlock();
      if (ok) {
        setRevealed(true);
        return { ok: true };
      }
      return { ok: false, needsPassword: false, error: "Couldn't verify — try again." };
    }
    try {
      await api.post("/v1/financial-privacy/reveal", { password });
      setRevealed(true);
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") return { ok: false, needsPassword: true };
      return { ok: false, needsPassword: false, error: err instanceof ApiError ? err.message : "Couldn't verify — try again." };
    }
  }

  function hide() {
    setRevealed(false);
  }

  const enabled = data.financialPrivacyModeEnabled;
  const masked = enabled && !revealed;

  return (
    <FinancialPrivacyContext.Provider
      value={{
        enabled,
        masked,
        revealed,
        requestReveal,
        hide,
        maskMoney: (formatted) => (masked ? MASKED_AMOUNT : formatted),
      }}
    >
      {children}
    </FinancialPrivacyContext.Provider>
  );
}

export function useFinancialPrivacy(): FinancialPrivacyContextValue {
  const ctx = useContext(FinancialPrivacyContext);
  if (!ctx) throw new Error("useFinancialPrivacy must be used within FinancialPrivacyProvider");
  return ctx;
}

/** Drop-in replacement for `formatMoneyMinorUnits` wherever a dollar amount renders on a FIN-007-covered
 * surface (mobile Home today) — same null/undefined-input behavior, so existing call sites don't need to
 * change their own guards. */
export function useMaskedMoney() {
  const { maskMoney } = useFinancialPrivacy();
  return (minorUnits: number | null | undefined, currency: string | null | undefined) => maskMoney(formatMoneyMinorUnits(minorUnits, currency));
}
