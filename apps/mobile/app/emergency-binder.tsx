import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, Share, Text, View, type AppStateStatus } from "react-native";
import { useFocusEffect } from "expo-router";
import * as LocalAuthentication from "expo-local-authentication";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
import { emergencyBinderCache, type CachedBinder, type EmergencyBinderPayload } from "@/lib/emergency-binder-cache";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { ScreenHeader } from "@/components/screen-header";
import { EmptyState } from "@/components/empty-state";

interface MyHousehold {
  household: { id: string; name: string };
}

const ROLE_LABEL: Record<string, string> = {
  individual_owner: "Owner",
  household_owner: "Owner",
  adult_member: "Adult member",
  dependent_profile: "Dependent",
  caregiver_delegate: "Caregiver",
  emergency_contact: "Emergency contact",
  support_agent: "Support agent",
  service_principal: "Service",
};

/** The household creator's own membership row is seeded server-side with the literal placeholder
 * relationshipLabel "self" (household.service.ts's `create()`) — rendering it verbatim reads as a data bug,
 * not a relationship label. Same fix already applied on web's settings/household page and binder page. */
function memberRelationshipLabel(m: EmergencyBinderPayload["members"][number]): string {
  if (m.relationshipLabel && m.relationshipLabel.toLowerCase() !== "self") return m.relationshipLabel;
  return ROLE_LABEL[m.role] || m.role;
}

type GateState = "locked" | "biometric-prompting" | "password-prompting" | "unlocked";

/**
 * Phase 2 §52.2 "emergency binder" mobile screen — the real cross-domain packet (household roster,
 * vehicles, property, flagged documents, medications/instructions), closing the "document-only subset"
 * gap (see docs/PHASE2_PENDING_CREDENTIALS.md). Two independent gates, both required:
 *  1. A LOCAL biometric prompt (Face ID/Touch ID/fingerprint via expo-local-authentication, already used
 *     for this app's global app-lock — see biometric-lock-context.tsx) or, if no biometric hardware/
 *     enrollment exists, the same password fallback web uses. This proves "the person holding this
 *     specific device right now" and re-triggers every time this screen gains focus — a cached view from
 *     an earlier visit never bypasses it (see useFocusEffect below, which resets to "locked" on every
 *     focus, before ever reading the AsyncStorage cache). useFocusEffect alone only covers *navigation*
 *     focus/blur (leaving to another tab/screen and coming back) — React Navigation's focus/blur events do
 *     NOT fire when the OS app is merely backgrounded and foregrounded while this screen stays the active
 *     route (confirmed against expo-router's own useFocusEffect implementation, which subscribes only to
 *     the navigator's 'focus'/'blur' events). So backgrounding is handled by a second, explicit AppState
 *     listener below — the same mechanism biometric-lock-context.tsx's app-wide lock already uses — scoped
 *     to only re-lock while this screen is the one currently focused.
 *  2. The server's own §28.9 step-up password check (EmergencyBinderService.getBinder) — a device-local
 *     biometric proves device possession, not "this person still knows the account password," so it can't
 *     substitute for the server-side control the web flow also goes through. In practice this means: after
 *     Face ID succeeds, the very first unlock this session may still prompt once for the account password
 *     (skipped entirely for an OAuth-only account, which has none to check) — never persisted, held only
 *     in this screen's own state for as long as it's open.
 */
export default function EmergencyBinderScreen() {
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [gate, setGate] = useState<GateState>("locked");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [binder, setBinder] = useState<EmergencyBinderPayload | null>(null);
  const [cached, setCached] = useState<CachedBinder | null>(null);
  const [offline, setOffline] = useState(false);
  const [householdId, setHouseholdId] = useState<string | null>(null);

  const isFocusedRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  function relock() {
    setGate("locked");
    setBinder(null);
    setPassword("");
    setError(null);
    emergencyBinderCache.get().then(setCached);
  }

  // Re-locks every time this screen is (re)focused via navigation — leaving to another tab/screen and
  // coming back must re-demand the gate rather than trusting a stale "already unlocked this session" flag.
  // Loads the offline cache eagerly (for the "last synced" line under the lock screen itself) but never
  // renders its contents until the gate below actually passes.
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      relock();
      return () => {
        isFocusedRef.current = false;
      };
    }, []),
  );

  // Covers the case useFocusEffect can't: the OS app being backgrounded (home button, app switcher, screen
  // lock) and foregrounded again while this screen remains the active route the whole time — no navigation
  // focus/blur event fires for that, so without this listener the binder would still be showing decrypted
  // household/medical data the instant the app comes back, with no fresh biometric/password check. Only
  // re-locks while this screen is actually the focused one (isFocusedRef), matching
  // biometric-lock-context.tsx's app-wide equivalent.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (appStateRef.current === "active" && next !== "active" && isFocusedRef.current) {
        relock();
      }
      appStateRef.current = next;
    });
    return () => sub.remove();
  }, []);

  async function resolveHouseholdId(): Promise<string | null> {
    if (householdId) return householdId;
    const households = await api.get<MyHousehold[]>("/v1/households");
    // Same "first household" simplification the Home tab's family-today card already makes (no
    // multi-household picker exists on mobile yet) — see app/(tabs)/index.tsx.
    const id = households[0]?.household.id ?? null;
    setHouseholdId(id);
    return id;
  }

  async function unlockWithPassword(withPassword?: string) {
    setError(null);
    try {
      const hhId = await resolveHouseholdId();
      if (!hhId) {
        setError("No household yet — create one on the web app first.");
        return;
      }
      const data = await api.post<EmergencyBinderPayload>(`/v1/emergency-binder/${hhId}/unlock`, { password: withPassword });
      setBinder(data);
      setOffline(false);
      setGate("unlocked");
      if (user) await emergencyBinderCache.set(data, user.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PASSWORD_REQUIRED") {
        setGate("password-prompting");
        return;
      }
      // No network (or the server's unreachable): fall back to whatever was last cached, rather than
      // leaving the user with nothing in exactly the offline scenario this feature exists for — but ONLY
      // if it was cached under the CURRENTLY signed-in user. Without this check, a second account signing
      // in on the same device (after the first account signed out) could see the first account's cached
      // household/medical data the instant a fetch here fails, entirely bypassing this account's own
      // membership/step-up checks (see emergency-binder-cache.ts's doc comment for the full story — this
      // is one of two independent guards against that, the other being clearing the cache on sign-out).
      if (cached && user && cached.ownerUserId === user.id && !(err instanceof ApiError)) {
        setBinder(cached.payload);
        setOffline(true);
        setGate("unlocked");
        return;
      }
      setError(err instanceof ApiError ? err.message : "Couldn't unlock the binder. Please try again.");
    }
  }

  async function startUnlock() {
    setError(null);
    if (Platform.OS !== "web") {
      const [hasHardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
      if (hasHardware && enrolled) {
        setGate("biometric-prompting");
        const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock the emergency binder" });
        if (!result.success) {
          setGate("locked");
          setError("Couldn't verify — try again.");
          return;
        }
        await unlockWithPassword(undefined);
        return;
      }
    }
    // No biometric hardware/enrollment (or running under `expo start --web`, which has none) — fall back
    // to the password flow directly. Never silently grants access: unlockWithPassword still goes through
    // the server's own step-up check, so a passwordless OAuth-only account is the only case that can
    // reach the data without typing anything, exactly like the web flow.
    await unlockWithPassword(undefined);
  }

  if (gate === "unlocked" && binder) {
    return <BinderView binder={binder} offline={offline} onLock={() => setGate("locked")} />;
  }

  return (
    <Screen>
      <ScreenHeader
        title="Emergency binder"
        // Android has no Face ID/Touch ID (Apple's branding) — its biometric prompt is Google's
        // BiometricPrompt (fingerprint/face unlock/device credential), so this copy is literally wrong
        // there. Same ios/else split biometric-lock-context.tsx and lock-gate.tsx already use.
        subtitle={
          Platform.OS === "ios"
            ? "Household roster, vehicles, property, and medical info in one place — locked behind Face ID/Touch ID or your password."
            : "Household roster, vehicles, property, and medical info in one place — locked behind your fingerprint or face unlock, or your password."
        }
      />
      <Card style={{ gap: 12 }}>
        {gate !== "password-prompting" && (
          <>
            <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>
              This combines several kinds of sensitive information at once, so it's locked separately from the rest of the app.
            </Text>
            <Button onPress={startUnlock} loading={gate === "biometric-prompting"}>
              Unlock
            </Button>
          </>
        )}
        {gate === "password-prompting" && (
          <View style={{ gap: 12 }}>
            <TextField
              label="Confirm your password to continue"
              secureTextEntry
              autoComplete="current-password"
              value={password}
              onChangeText={setPassword}
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={() => unlockWithPassword(password)}>Unlock</Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setGate("locked")}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
        {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
        {cached && gate === "locked" && (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Last synced {new Date(cached.cachedAtIso).toLocaleString()} — available offline once unlocked.
          </Text>
        )}
      </Card>
    </Screen>
  );
}

/** Plain-text summary for the OS share sheet — the same "no PDF library in this app, don't add one just
 * for this" reasoning as the web page's print stylesheet (see apps/web's emergency-binder page.tsx),
 * except mobile has no print/save-as-PDF equivalent, so `Share.share` (built into React Native, zero new
 * dependencies) is the conservative choice: it hands this text to Messages/Mail/Notes/AirDrop/a printer
 * driver — whatever the device already offers — rather than this app trying to generate a PDF itself. */
function binderToPlainText(binder: EmergencyBinderPayload): string {
  const lines: string[] = [`${binder.household.name} — Emergency binder`, `Generated ${new Date(binder.generatedAt).toLocaleString()}`, ""];
  if (binder.medicationsNotes) lines.push("MEDICATIONS", binder.medicationsNotes, "");
  if (binder.emergencyInstructions) lines.push("EMERGENCY INSTRUCTIONS", binder.emergencyInstructions, "");
  const activeMembers = binder.members.filter((m) => m.status === "active");
  if (activeMembers.length || binder.dependents.length) {
    lines.push("HOUSEHOLD");
    for (const m of activeMembers) lines.push(`- ${m.displayName || m.email || "Household member"} (${memberRelationshipLabel(m)})`);
    for (const d of binder.dependents) lines.push(`- ${d.displayName} (Dependent)`);
    lines.push("");
  }
  if (binder.vehicles.length) {
    lines.push("VEHICLES");
    for (const v of binder.vehicles) lines.push(`- ${v.label}: ${[v.year, v.make, v.model].filter(Boolean).join(" ")}${v.vin ? ` (VIN ${v.vin})` : ""}`);
    lines.push("");
  }
  if (binder.properties.length) {
    lines.push("PROPERTY");
    for (const p of binder.properties) lines.push(`- ${p.label}: ${p.address || p.propertyType}`);
    lines.push("");
  }
  if (binder.pets.length) {
    lines.push("PETS");
    for (const pet of binder.pets) {
      const details = [pet.species, pet.breed].filter(Boolean).join(" ");
      lines.push(`- ${pet.label}${details ? ` (${details})` : ""}`);
      if (pet.vetProviderName) lines.push(`  Vet: ${pet.vetProviderName}`);
      if (pet.insuranceProviderName) lines.push(`  Insurance: ${pet.insuranceProviderName}`);
      if (pet.microchipNumber) lines.push(`  Microchip: ${pet.microchipNumber}`);
      for (const m of pet.medications) lines.push(`  Medication: ${m.medicationName}${m.pharmacy ? ` (${m.pharmacy})` : ""}`);
      for (const v of pet.vaccinations) lines.push(`  Vaccination: ${v.label}`);
    }
    lines.push("");
  }
  if (binder.documents.length) {
    lines.push("DOCUMENTS");
    for (const doc of binder.documents) lines.push(`- ${doc.title} (${doc.documentType.replace(/_/g, " ")})`);
  }
  return lines.join("\n");
}

/**
 * Found live while auditing this feature: unlike purchase/[id].tsx's RET-006 ResalePanel.share() (which
 * already wraps its own Share.share() call in try/catch), this one had none — a real user dismissing the
 * OS share sheet rejects the promise the same way there, but on a platform/browser where Share isn't
 * available at all (confirmed via the Expo web preview: react-native-web's Share.share throws
 * synchronously with "Share is not supported in this browser" rather than returning a rejected promise),
 * an unguarded call crashes the whole screen instead of failing quietly. Fixed by matching that same
 * try/catch shape here.
 */
async function shareBinder(binder: EmergencyBinderPayload): Promise<void> {
  try {
    await Share.share({ message: binderToPlainText(binder) });
  } catch {
    // Share unavailable on this platform/browser, or the user dismissed the share sheet — either way,
    // nothing to do; the binder itself is still visible on screen.
  }
}

function BinderView({ binder, offline, onLock }: { binder: EmergencyBinderPayload; offline: boolean; onLock: () => void }) {
  const { theme } = useAppTheme();
  const activeMembers = binder.members.filter((m) => m.status === "active");

  return (
    <Screen>
      <ScreenHeader title={binder.household.name} subtitle="Emergency binder" />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
          {offline ? "Offline — showing the last synced copy" : `Generated ${new Date(binder.generatedAt).toLocaleString()}`}
        </Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button variant="secondary" onPress={() => shareBinder(binder)}>
            Share / Print
          </Button>
          <Button variant="ghost" onPress={onLock}>
            Hide
          </Button>
        </View>
      </View>

      {(binder.medicationsNotes || binder.emergencyInstructions) && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Medications &amp; instructions
          </Text>
          <Card style={{ gap: 12 }}>
            {binder.medicationsNotes && (
              <View style={{ gap: 2 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Medications</Text>
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>{binder.medicationsNotes}</Text>
              </View>
            )}
            {binder.emergencyInstructions && (
              <View style={{ gap: 2 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Emergency instructions</Text>
                <Text style={{ fontSize: 14, color: theme.colors.textSecondary }}>{binder.emergencyInstructions}</Text>
              </View>
            )}
          </Card>
        </View>
      )}

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Household</Text>
        <Card style={{ gap: 10 }}>
          {activeMembers.map((m) => (
            <View key={m.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{m.displayName || m.email || "Household member"}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{memberRelationshipLabel(m)}</Text>
            </View>
          ))}
          {binder.dependents.map((d) => (
            <View key={d.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{d.displayName}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Dependent</Text>
            </View>
          ))}
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Vehicles</Text>
        {binder.vehicles.length === 0 ? (
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>None on file.</Text>
        ) : (
          <Card style={{ gap: 10 }}>
            {binder.vehicles.map((v) => (
              <View key={v.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{v.label}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                  {[v.year, v.make, v.model].filter(Boolean).join(" ")}
                  {v.vin ? ` · VIN ${v.vin}` : ""}
                </Text>
              </View>
            ))}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Property</Text>
        {binder.properties.length === 0 ? (
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>None on file.</Text>
        ) : (
          <Card style={{ gap: 10 }}>
            {binder.properties.map((p) => (
              <View key={p.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.label}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{p.address || p.propertyType}</Text>
              </View>
            ))}
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Pets</Text>
        {binder.pets.length === 0 ? (
          <Text style={{ fontSize: 14, color: theme.colors.textTertiary }}>None on file.</Text>
        ) : (
          <View style={{ gap: 8 }}>
            {binder.pets.map((pet) => (
              <Card key={pet.id} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{pet.label}</Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{[pet.species, pet.breed].filter(Boolean).join(" · ")}</Text>
                </View>
                {(pet.vetProviderName || pet.insuranceProviderName || pet.microchipNumber) && (
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                    {[pet.vetProviderName && `Vet: ${pet.vetProviderName}`, pet.insuranceProviderName && `Insurance: ${pet.insuranceProviderName}`, pet.microchipNumber && `Microchip: ${pet.microchipNumber}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                )}
                {pet.medications.length > 0 && (
                  <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                    Medications: {pet.medications.map((m) => `${m.medicationName}${m.pharmacy ? ` (${m.pharmacy})` : ""}`).join(", ")}
                  </Text>
                )}
                {pet.vaccinations.length > 0 && (
                  <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>Vaccinations: {pet.vaccinations.map((v) => v.label).join(", ")}</Text>
                )}
              </Card>
            ))}
          </View>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Documents</Text>
        {binder.documents.length === 0 ? (
          <EmptyState title="Nothing flagged yet" description="Flag a shared document from Documents on the web app to add it here." />
        ) : (
          <Card style={{ gap: 10 }}>
            {binder.documents.map((doc) => (
              <View key={doc.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{doc.title}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{doc.documentType.replace(/_/g, " ")}</Text>
              </View>
            ))}
          </Card>
        )}
      </View>
    </Screen>
  );
}
