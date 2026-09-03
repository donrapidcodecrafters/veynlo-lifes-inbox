"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { api, ApiError } from "./api-client";
import { formatMoneyMinorUnits } from "./format";
import { usePersonalizationPreferences } from "@/hooks/use-personalization";

/** Same shared placeholder `@veynlo/core`'s `MASKED_AMOUNT_PLACEHOLDER` uses server-side (notification
 * copy, widget projections) — kept as a plain literal here rather than importing the API-only package, the
 * same "server and client independently agree on one constant" posture other cross-cutting UI strings in
 * this app already have. */
const MASKED_AMOUNT = "••••";

interface FinancialPrivacyContextValue {
  /** The stored preference itself — whether financial privacy mode is turned on at all. */
  enabled: boolean;
  /** Whether amounts should currently render masked — `enabled && !revealed`. */
  masked: boolean;
  /** True once this session has stepped up past the mask for the current view (never persisted — a fresh
   * page load always starts masked again, matching the spec's "mask by default" line). */
  revealed: boolean;
  /** Step-up reveal (FIN-007 "biometric reveal option" — web's password counterpart to mobile's on-device
   * Face ID/Touch ID via BiometricLockContext). Mirrors the app's other reveal flows: call with no password
   * first, and only prompt for one if the server actually asks. */
  requestReveal: (password?: string) => Promise<{ ok: true } | { ok: false; needsPassword: boolean; error?: string }>;
  /** Re-masks immediately (e.g. leaving the page, or an explicit "Hide" action) without waiting for a
   * fresh page load. */
  hide: () => void;
  /** Renders a dollar amount either normally or as the shared masked placeholder, depending on `masked`. */
  maskMoney: (formatted: string | null) => string | null;
}

const FinancialPrivacyContext = createContext<FinancialPrivacyContextValue | null>(null);

/**
 * FIN-007 "Financial privacy mode ... Mask by default on lock screen; biometric reveal option." Wraps the
 * authenticated app shell (see `(app)/layout.tsx`) so every page — not just Home — can mask a dollar amount
 * without threading a fresh SWR fetch + reveal-prompt state through each one. `revealed` lives only in this
 * provider's React state: it is NEVER persisted server-side (see `PreferencesService.revealFinancialPrivacy`'s
 * own doc comment) and NEVER used to unmask a widget or notification — those are always masked server-side
 * with no reveal path at all, the same "widget tap is the single most exposed reading context this app has"
 * posture `WidgetsService`'s own doc comment describes.
 */
export function FinancialPrivacyProvider({ children }: { children: ReactNode }) {
  const { data } = usePersonalizationPreferences();
  const [revealed, setRevealed] = useState(false);

  async function requestReveal(password?: string): Promise<{ ok: true } | { ok: false; needsPassword: boolean; error?: string }> {
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

/** Convenience wrapper around `formatMoneyMinorUnits` — the drop-in replacement for that call wherever a
 * dollar amount renders on a FIN-007-covered surface (Home/life page today). Returns null under the exact
 * same null/undefined inputs `formatMoneyMinorUnits` already does, so existing `{amount && ...}` guards at
 * call sites keep working unchanged. */
export function useMaskedMoney() {
  const { maskMoney } = useFinancialPrivacy();
  return (minorUnits: number | null | undefined, currency: string | null | undefined, locale?: string) =>
    maskMoney(formatMoneyMinorUnits(minorUnits, currency, locale));
}
