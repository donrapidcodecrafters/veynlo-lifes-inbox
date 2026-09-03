import { Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";
import { Button } from "./button";

interface FetchErrorProps {
  /** Optional specifics from the real server error (ApiError.message) — shown alongside the generic
   * copy rather than instead of it, mirroring apps/web's own FetchError. */
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
  /** Swap the noun in the default copy ("your inbox", "your documents") — optional, generic fallback. */
  what?: string;
}

/**
 * Mobile counterpart to apps/web/src/components/ui/fetch-error.tsx — see that file's own doc comment
 * for the full reasoning. Distinct from the app's global 401 handling (api-client.ts already redirects
 * to sign-in on a dead session) and distinct from a genuine empty state (EmptyState): this is for a
 * transient 500/network/timeout on an otherwise-working session, which previously rendered as an
 * indistinguishable blank/empty screen with no way to recover short of leaving and re-entering the screen.
 */
export function FetchError({ message, onRetry, retrying, what }: FetchErrorProps) {
  const { theme } = useAppTheme();
  return (
    <View
      style={{
        backgroundColor: theme.colors.criticalSubtleBg,
        borderRadius: theme.radius.lg,
        padding: 20,
        alignItems: "center",
        gap: 10,
      }}
      accessibilityLiveRegion="assertive"
      accessibilityRole="alert"
    >
      <View style={{ gap: 4, alignItems: "center" }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.criticalSubtleText, textAlign: "center" }}>
          Something went wrong loading {what ?? "this"}.
        </Text>
        {message && (
          <Text style={{ fontSize: 12, color: theme.colors.criticalSubtleText, textAlign: "center", opacity: 0.85 }}>{message}</Text>
        )}
      </View>
      <Button variant="secondary" onPress={onRetry} loading={retrying}>
        Retry
      </Button>
    </View>
  );
}
