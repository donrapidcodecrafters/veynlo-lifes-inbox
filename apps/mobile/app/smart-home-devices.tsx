import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { FetchError } from "@/components/fetch-error";
import { api, ApiError } from "@/lib/api-client";

/**
 * Which devices Veynlo reads from a Home Assistant.
 *
 * ---------------------------------------------------------------------------------------------------
 * The same shape as the notification picker, for the same reason
 * ---------------------------------------------------------------------------------------------------
 * A Long-Lived Access Token can read every entity in the house, including the ones that say whether anyone
 * is home. That breadth is not the authorization — this list is, exactly as Android's all-or-nothing
 * Notification Access grant is not the authorization and the per-app list is.
 *
 * Nothing at all is read until something here is on.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why it is a separate screen
 * ---------------------------------------------------------------------------------------------------
 * A real Home Assistant has hundreds of entities. Even after the connector drops the diagnostic clutter —
 * uptime counters, signal strengths, firmware strings — a normal house leaves thirty or forty things to
 * choose between. On a phone that is a screen, not a section of one.
 */
interface Device {
  providerDeviceId: string;
  label: string;
  deviceType: string;
  room: string | null;
  isSelected: boolean;
}

/** Plain words for the entity domains this connector offers. "binary_sensor" means nothing to a person. */
const DEVICE_TYPE_LABEL: Record<string, string> = {
  lock: "Lock",
  thermostat: "Thermostat",
  camera: "Camera",
  sensor: "Sensor",
  hub: "Hub",
  other: "Other",
};

export default function SmartHomeDevicesScreen() {
  const { theme } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    void (async () => {
      try {
        const result = await api.get<Device[]>(`/v1/smart-home/connections/${id}/devices`);
        setDevices(result);
        setSelected(result.filter((d) => d.isSelected).map((d) => d.providerDeviceId));
        setLoadError(null);
      } catch (err) {
        // Shown as sent: "couldn't reach it", "the token was rejected" and "that isn't Home Assistant"
        // need three different things from the person reading them.
        setLoadError(err instanceof ApiError ? err.message : "Couldn't load the devices on this Home Assistant.");
      }
    })();
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const serverSelection = useMemo(
    () => (devices ?? []).filter((d) => d.isSelected).map((d) => d.providerDeviceId),
    [devices],
  );

  // Save is only offered when there is genuinely something to save. A button that is always enabled and
  // usually a no-op teaches people to press it without reading.
  const dirty =
    selected.length !== serverSelection.length || selected.some((entityId) => !serverSelection.includes(entityId));

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = devices ?? [];
    if (!q) return all;
    return all.filter((d) => d.label.toLowerCase().includes(q) || d.providerDeviceId.toLowerCase().includes(q));
  }, [devices, query]);

  function toggle(entityId: string) {
    setSaved(false);
    setSaveError(null);
    setSelected((current) => (current.includes(entityId) ? current.filter((e) => e !== entityId) : [...current, entityId]));
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put(`/v1/smart-home/connections/${id}/devices`, { providerDeviceIds: selected });
      setSaved(true);
      load();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't save your choices. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Choose devices" subtitle="Veynlo reads only the devices you turn on here." />

      <Card style={{ gap: 8 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>What gets read</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, lineHeight: 19 }}>
          A leak, smoke or carbon monoxide, a flat battery, a fault, and anything that&apos;s stopped responding — from the devices you
          choose here and nothing else. Not history, not energy use, not who&apos;s home.
        </Text>
      </Card>

      {!devices && !loadError && (
        <View
          style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      )}

      {!devices && loadError && <FetchError what="the devices on this Home Assistant" message={loadError} onRetry={load} />}

      {devices && devices.length === 0 && (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Nothing to choose from yet</Text>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, lineHeight: 19 }}>
            This Home Assistant didn&apos;t report any locks, thermostats, cameras or sensors Veynlo can use. If you&apos;ve just set it
            up, add a device there and come back.
          </Text>
        </Card>
      )}

      {devices && devices.length > 0 && (
        <Card style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Devices</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              {selected.length === 0 ? "None chosen" : `${selected.length} of ${devices.length} chosen`}
            </Text>
          </View>

          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search devices"
            placeholderTextColor={theme.colors.textTertiary}
            accessibilityLabel="Search devices"
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

          {shown.length === 0 && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No devices match that.</Text>
          )}

          {shown.map((device) => {
            const on = selected.includes(device.providerDeviceId);
            const detail = `${DEVICE_TYPE_LABEL[device.deviceType] ?? device.deviceType}${device.room ? ` · ${device.room}` : ""}`;
            return (
              <Pressable
                key={device.providerDeviceId}
                onPress={() => toggle(device.providerDeviceId)}
                accessibilityRole="switch"
                accessibilityState={{ checked: on }}
                accessibilityLabel={device.label}
                accessibilityHint={detail}
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
                  // Always outlined — a row that can be turned on is a control, and a control with no
                  // border is not visibly one.
                  borderWidth: 1,
                  borderColor: on ? theme.colors.brandDefault : theme.colors.borderDefault,
                  backgroundColor: on ? theme.colors.brandSubtleBg : "transparent",
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: on ? "600" : "400",
                      color: on ? theme.colors.brandDefault : theme.colors.textPrimary,
                    }}
                  >
                    {device.label}
                  </Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{detail}</Text>
                </View>
                <Text style={{ fontSize: 12, fontWeight: "600", color: on ? theme.colors.brandDefault : theme.colors.textTertiary }}>
                  {on ? "On" : "Off"}
                </Text>
              </Pressable>
            );
          })}

          {saveError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{saveError}</Text>}
          {saved && !dirty && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Saved.</Text>}

          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button onPress={save} loading={saving} disabled={!dirty}>
              Save choices
            </Button>
            {dirty && (
              <Button
                variant="secondary"
                onPress={() => {
                  setSelected(serverSelection);
                  setSaved(false);
                  setSaveError(null);
                }}
                disabled={saving}
              >
                Undo changes
              </Button>
            )}
          </View>
        </Card>
      )}
    </Screen>
  );
}
