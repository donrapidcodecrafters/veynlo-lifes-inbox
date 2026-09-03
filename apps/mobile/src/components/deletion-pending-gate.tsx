import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@/lib/auth-context";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Card } from "./card";
import { Button } from "./button";

/**
 * PRIV-002 grace period — mirrors apps/web's (app)/layout.tsx `DeletionPendingScreen` exactly. A
 * `deletion_pending` account CAN sign in (specifically so it can cancel — see IdentityService.signIn's own
 * doc comment), but every other authenticated route/API call 401s server-side with ACCOUNT_DELETION_PENDING
 * until the deletion is cancelled (api-client.ts exempts that code from the usual "session died" handling,
 * see its own comment). Sitting above the whole root Stack — tabs and every pushed screen alike — rather
 * than inside just the tab navigator means a deep link straight into e.g. /connections can't slip past this
 * and hit a screen that would just silently fail every fetch it makes.
 */
export function DeletionPendingGate({ children }: { children: ReactNode }) {
  const { user, signOut, refreshUser } = useAuth();
  const { theme } = useAppTheme();
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user || user.status !== "deletion_pending") return <>{children}</>;

  const daysLeft = user.scheduledDeletionAt
    ? Math.max(0, Math.ceil((new Date(user.scheduledDeletionAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : null;

  async function cancelDeletion() {
    setCancelling(true);
    setError(null);
    try {
      await api.post("/v1/auth/cancel-deletion");
      await refreshUser(); // flips `user.status` back to "active", which un-mounts this gate on the next render
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel deletion. Please try again.");
      setCancelling(false);
    }
  }

  async function onSignOut() {
    await signOut();
    router.replace("/sign-in");
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bgCanvas, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Card style={{ gap: 16, width: "100%", maxWidth: 420 }}>
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>Your account is scheduled for deletion</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>
            {user.scheduledDeletionAt ? (
              <>
                Everything will be permanently deleted on{" "}
                <Text style={{ fontWeight: "700", color: theme.colors.textPrimary }}>
                  {new Date(user.scheduledDeletionAt).toLocaleDateString(undefined, { dateStyle: "long" })}
                </Text>
                {daysLeft !== null ? ` (${daysLeft} day${daysLeft === 1 ? "" : "s"} from now)` : ""}. Until then, you can cancel and keep your
                account exactly as it was.
              </>
            ) : (
              "Your account is scheduled for deletion. You can cancel and keep your account exactly as it was."
            )}
          </Text>
        </View>
        {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
        <Button onPress={cancelDeletion} loading={cancelling}>
          Cancel deletion &amp; keep my account
        </Button>
        <Button variant="secondary" onPress={onSignOut}>
          Sign out
        </Button>
      </Card>
    </View>
  );
}
