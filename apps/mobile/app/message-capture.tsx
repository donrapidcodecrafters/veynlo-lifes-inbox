import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import {
  notificationCaptureStore,
  isListenerEnabled,
  openNotificationAccessSettings,
  drainPendingCaptures,
} from "@/lib/notification-capture";

/**
 * §32 messaging capture boundaries — a dedicated screen rather than an inline settings toggle,
 * specifically so the disclosure text below is impossible to miss before someone turns this on. Only
 * reachable at all when Platform.OS === "android" and the `android_notification_capture` feature flag is
 * on (see (tabs)/settings.tsx) — this deployment may not have the flag enabled yet regardless of what
 * this screen itself supports, matching the "not configured" degradation used elsewhere in this app.
 */
export default function MessageCaptureScreen() {
  const { theme } = useAppTheme();
  const [optedIn, setOptedIn] = useState(false);
  const [listenerGranted, setListenerGranted] = useState(false);
  const [draining, setDraining] = useState(false);

  const refresh = useCallback(async () => {
    setOptedIn(await notificationCaptureStore.isOptedIn());
    setListenerGranted(isListenerEnabled());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  async function toggleOptIn(next: boolean) {
    await notificationCaptureStore.setOptedIn(next);
    setOptedIn(next);
    if (next && !listenerGranted) openNotificationAccessSettings();
    if (!next) return;
    setDraining(true);
    await drainPendingCaptures().catch(() => {});
    setDraining(false);
  }

  return (
    <Screen>
      <ScreenHeader
        title="Message capture"
        subtitle="Let Veynlo notice bills and appointments that arrive as a text message."
      />

      <Card style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>What this actually does</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, lineHeight: 19 }}>
          When this is on, Veynlo reads notifications only from your phone's SMS/RCS messaging app — never
          WhatsApp, Signal, Telegram, or anything else. Only the notification's title and preview text are
          used, only to check for the same kind of bill or appointment reminder already found in email —
          nothing is stored beyond that, and nothing is ever read if this toggle is off.
        </Text>
      </Card>

      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Turn on message capture</Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, marginTop: 2 }}>
            {optedIn
              ? listenerGranted
                ? "On — notification access is granted."
                : "Almost — finish granting Notification Access below."
              : "Off."}
          </Text>
        </View>
        <View style={{ minWidth: 90 }}>
          <Button variant={optedIn ? "secondary" : "primary"} onPress={() => toggleOptIn(!optedIn)} loading={draining}>
            {optedIn ? "Turn off" : "Turn on"}
          </Button>
        </View>
      </Card>

      {optedIn && !listenerGranted && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Android requires granting this from its own Notification Access settings screen, not a normal
            permission prompt.
          </Text>
          <Button variant="secondary" onPress={openNotificationAccessSettings}>
            Open Notification Access settings
          </Button>
        </Card>
      )}
    </Screen>
  );
}
