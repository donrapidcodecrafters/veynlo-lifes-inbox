import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { listInstalledApps, getAllowedPackages, setAllowedPackages, defaultAllowedPackages } from "@/lib/notification-capture";
import type { InstalledApp } from "../modules/veynlo-notification-capture/src/VeynloNotificationCapture.types";

/**
 * Which apps Veynlo may read notifications from.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this screen exists
 * ---------------------------------------------------------------------------------------------------
 * Android's Notification Access grant is all-or-nothing: once it is on, this app could read every
 * notification on the device. That is far more than it should, so the grant is deliberately NOT treated as
 * the authorization. This list is.
 *
 * Capture originally read three SMS packages and nothing else, which caught bills and appointments that
 * arrive as texts and missed the larger half of the same problem — the airline saying the gate moved, the
 * pharmacy saying a prescription is ready, the courier saying a parcel arrives today. Those are app
 * notifications, never SMS.
 *
 * A curated list of "known useful" apps would be endless and wrong for most households, so the user picks.
 * Nothing is read from an app they have not chosen, and unchoosing one takes effect on the very next
 * notification rather than at some later restart.
 *
 * ---------------------------------------------------------------------------------------------------
 * A note on the list itself
 * ---------------------------------------------------------------------------------------------------
 * Only apps with a launcher entry are offered. A device lists well over a hundred packages and nearly all
 * of them are system components that never post anything a household cares about; showing them would bury
 * the twenty the person actually recognises.
 *
 * Messaging apps appear as already-on and cannot be switched off here, because they are read regardless —
 * that is what this feature shipped as, and someone who already relies on it must not lose it silently
 * just because a new list starts out empty.
 */
export default function NotificationAppsScreen() {
  const { theme } = useAppTheme();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [always, setAlways] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    try {
      setApps(listInstalledApps());
      setAllowed(getAllowedPackages());
      setAlways(defaultAllowedPackages());
      setError(null);
    } catch {
      // A read, not a user action — keep whatever was last shown rather than blanking the screen, but say
      // so, since an empty list is otherwise indistinguishable from "this phone has no apps".
      setError("Couldn't read the list of apps on this phone.");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  function toggle(packageName: string) {
    setError(null);
    const next = allowed.includes(packageName) ? allowed.filter((p) => p !== packageName) : [...allowed, packageName];
    try {
      // Written through to the native store immediately rather than on leaving the screen: the listener
      // reads this on every notification, and a change the user made but did not "save" would be a change
      // they believe took effect and did not.
      setAllowedPackages(next);
      setAllowed(next);
    } catch {
      setError("Couldn't save that change. Please try again.");
    }
  }

  const alwaysOn = useMemo(() => apps.filter((a) => always.includes(a.packageName)), [apps, always]);
  const selectable = useMemo(() => {
    const rest = apps.filter((a) => !always.includes(a.packageName));
    const q = query.trim().toLowerCase();
    if (!q) return rest;
    return rest.filter((a) => a.label.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q));
  }, [apps, always, query]);

  const chosenCount = allowed.length;

  return (
    <Screen>
      <ScreenHeader
        title="Apps Veynlo reads"
        subtitle="Pick the apps whose notifications Veynlo may look at. Nothing else is read."
      />

      <Card style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>What gets read</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, lineHeight: 19 }}>
          Only the notification&apos;s title and preview text, and only from the apps you choose here — used to
          spot the same appointments, deliveries and bills Veynlo already finds in email. Turning an app off
          stops it being read straight away.
        </Text>
      </Card>

      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}

      {alwaysOn.length > 0 && (
        <Card style={{ gap: 10 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Always on
          </Text>
          {alwaysOn.map((app) => (
            <View key={app.packageName} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>{app.label}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Text messages — read whenever capture is on.</Text>
              </View>
            </View>
          ))}
        </Card>
      )}

      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Other apps
          </Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            {chosenCount === 0 ? "None chosen" : `${chosenCount} chosen`}
          </Text>
        </View>

        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search apps"
          placeholderTextColor={theme.colors.textTertiary}
          accessibilityLabel="Search apps"
          autoCapitalize="none"
          autoCorrect={false}
          style={{
            minHeight: 40,
            borderWidth: 1,
            borderColor: theme.colors.borderDefault,
            borderRadius: theme.radius.md,
            paddingHorizontal: 12,
            color: theme.colors.textPrimary,
          }}
        />

        {selectable.length === 0 && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            {query.trim() ? "No apps match that." : "No other apps on this phone post notifications Veynlo can read."}
          </Text>
        )}

        {selectable.map((app) => {
          const on = allowed.includes(app.packageName);
          return (
            <Pressable
              key={app.packageName}
              onPress={() => toggle(app.packageName)}
              accessibilityRole="switch"
              accessibilityState={{ checked: on }}
              accessibilityLabel={app.label}
              hitSlop={6}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                minHeight: 44,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: theme.radius.md,
                // Always outlined — a row that can be turned on is a control, and a control with no border
                // is not visibly one.
                borderWidth: 1,
                borderColor: on ? theme.colors.brandDefault : theme.colors.borderDefault,
                backgroundColor: on ? theme.colors.brandSubtleBg : "transparent",
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: on ? "600" : "400", color: on ? theme.colors.brandDefault : theme.colors.textPrimary }}>
                  {app.label}
                </Text>
                {app.isSystemApp && (
                  <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Came with the phone</Text>
                )}
              </View>
              <Text style={{ fontSize: 13, fontWeight: "600", color: on ? theme.colors.brandDefault : theme.colors.textTertiary }}>
                {on ? "On" : "Off"}
              </Text>
            </Pressable>
          );
        })}
      </Card>
    </Screen>
  );
}
