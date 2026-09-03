import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { geofencingAvailable, getPermissionSnapshot, requestBackgroundPermission, requestForegroundPermission } from "@/lib/geofencing";
import type { LocationPermissionSnapshot } from "@/lib/geofencing.types";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";

type Step = "intro" | "foreground" | "background" | "done";

/**
 * §30.1 "Location must be opt-in, purpose-specific, battery-aware, and easy to disable... Users must be
 * able to use Life Inbox fully without granting location." / LOC-001 "Separate foreground/background/
 * precise consent; clear explanation." This screen is the one place in the app that asks for location
 * permission — it's reached only from Saved Places, never on app launch, and each OS permission tier gets
 * its own screen with its own plain-language explanation BEFORE the system prompt fires, matching this
 * app's existing consent-explanation pattern for camera/microphone (see capture.tsx) and biometrics (see
 * emergency-binder.tsx). Declining at any step is a fully supported end state, not a dead end — Saved
 * Places still works with places you enter manually, just without arrival/departure reminders.
 *
 * Every report to the server (`PUT /v1/location-permission-state`) is a STATUS FLAG, not a location log —
 * see `LocationService`'s own doc comment (LOC-006) for the guarantee this screen never writes a
 * coordinate anywhere.
 */
export default function LocationPermissionsScreen() {
  const { theme } = useAppTheme();
  const [step, setStep] = useState<Step>("intro");
  const [snapshot, setSnapshot] = useState<LocationPermissionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getPermissionSnapshot()
      .then(setSnapshot)
      .catch(() => setSnapshot(null));
  }, []);

  useFocusEffect(refresh);

  async function reportState(next: LocationPermissionSnapshot) {
    try {
      await api.put("/v1/location-permission-state", {
        foregroundStatus: next.foreground,
        backgroundStatus: next.background,
        precision: next.precision,
      });
    } catch {
      // Best-effort — the OS-level permission itself is the source of truth for whether geofencing works;
      // a failed status report to the server just means Saved Places' own display of "granted"/"denied"
      // might be briefly stale on next load, not a functional problem.
    }
  }

  async function handleAllowForeground() {
    setBusy(true);
    setError(null);
    try {
      const next = await requestForegroundPermission();
      setSnapshot(next);
      await reportState(next);
      setStep(next.foreground === "granted" ? "background" : "done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't request location permission.");
    } finally {
      setBusy(false);
    }
  }

  async function handleAllowBackground() {
    setBusy(true);
    setError(null);
    try {
      const next = await requestBackgroundPermission();
      setSnapshot(next);
      await reportState(next);
      setStep("done");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't request background location permission.");
    } finally {
      setBusy(false);
    }
  }

  function skipTo(next: Step) {
    setStep(next);
  }

  return (
    <Screen>
      <ScreenHeader title="Location for reminders" subtitle="Optional — used only for the reminders you set up yourself" />

      {!geofencingAvailable && (
        <Card style={{ backgroundColor: theme.colors.warningSubtleBg }}>
          <Text style={{ color: theme.colors.warningSubtleText, fontSize: 14 }}>
            Location permissions aren&apos;t available in this preview. Use the installed app to grant location access and set up
            arrival/departure reminders.
          </Text>
        </Card>
      )}

      {error && (
        <Card style={{ backgroundColor: theme.colors.criticalSubtleBg }}>
          <Text style={{ color: theme.colors.criticalSubtleText, fontSize: 14 }}>{error}</Text>
        </Card>
      )}

      {step === "intro" && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>What this is for</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }}>
            Saved Places works fully without location — you can add a home, a relative&apos;s address, or a store manually and see it
            on your list. Location access adds one thing: a reminder that fires automatically when you arrive at or leave a place you
            chose, like &quot;remind me to check the sprinkler when I get home.&quot;
          </Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }}>
            Veynlo never records where you&apos;ve been. Only the moment a reminder you set up actually fires is saved — never a
            continuous trail of your movements.
          </Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }}>
            You&apos;ll be asked for two separate permissions, one at a time, and can stop after either one.
          </Text>
          <Button onPress={() => setStep("foreground")}>Continue</Button>
          <Button variant="ghost" onPress={() => router.back()}>
            Not now
          </Button>
        </Card>
      )}

      {step === "foreground" && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>1. While using Veynlo</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }}>
            This lets Veynlo see your current location only while the app is open — to help you drop a pin when saving a new place,
            and to show places near you. It does not let reminders fire when the app is closed; that needs the second permission,
            asked separately next.
          </Text>
          {snapshot && (
            <Badge tone={snapshot.foreground === "granted" ? "positive" : "neutral"}>{`Current status: ${snapshot.foreground}`}</Badge>
          )}
          <Button onPress={handleAllowForeground} loading={busy} disabled={!geofencingAvailable}>
            Allow while using the app
          </Button>
          <Button variant="ghost" onPress={() => skipTo("done")}>
            Skip — I&apos;ll enter places manually
          </Button>
        </Card>
      )}

      {step === "background" && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>2. In the background</Text>
          <Text style={{ fontSize: 14, color: theme.colors.textSecondary, lineHeight: 20 }}>
            This lets an arrival/departure reminder you&apos;ve set up fire even when Veynlo isn&apos;t open — for example, getting
            reminded to check the sprinkler the moment you actually get home, not just the next time you happen to open the app.
            Veynlo only wakes briefly to check whether you crossed the boundary of a place you saved; it does not track or store your
            location otherwise.
          </Text>
          {snapshot && (
            <Badge tone={snapshot.background === "granted" ? "positive" : "neutral"}>{`Current status: ${snapshot.background}`}</Badge>
          )}
          <Button onPress={handleAllowBackground} loading={busy} disabled={!geofencingAvailable}>
            Allow in the background
          </Button>
          <Button variant="ghost" onPress={() => skipTo("done")}>
            Skip — reminders only while Veynlo is open
          </Button>
        </Card>
      )}

      {step === "done" && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>You&apos;re set</Text>
          {snapshot && (
            <View style={{ gap: 6 }}>
              <Badge tone={snapshot.foreground === "granted" ? "positive" : "neutral"}>{`While using the app: ${snapshot.foreground}`}</Badge>
              <Badge tone={snapshot.background === "granted" ? "positive" : "neutral"}>{`In the background: ${snapshot.background}`}</Badge>
              <Badge tone="neutral">{`Location precision: ${snapshot.precision}`}</Badge>
            </View>
          )}
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary, lineHeight: 18 }}>
            You can change any of this later in your device&apos;s Settings app, including switching between precise and approximate
            location — Veynlo can&apos;t override that choice.
          </Text>
          <Button onPress={() => router.replace("/places")}>Go to Saved Places</Button>
        </Card>
      )}
    </Screen>
  );
}
