import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { Badge } from "@/components/badge";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";

interface MyHousehold {
  household: { id: string; name: string };
  membership: { role: string };
}

interface Dependent {
  id: string;
  displayName: string;
  birthDate: string | null;
  hasOwnAccount: boolean;
  linkedUserId: string | null;
  transitionInvitedEmail: string | null;
  transitionInviteTokenExpiresAt: string | null;
}

function apiErrorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    const firstFieldError = err.fieldErrors && Object.values(err.fieldErrors).flat()[0];
    return firstFieldError || err.message;
  }
  return fallback;
}

/**
 * FAM-001 "later invite/transition path when appropriate" — mobile counterpart to
 * apps/web's settings/household dependents section, scoped to just dependents + the account-transition
 * action (this app has no fuller household-management screen yet — no invite/rename/delegation UI exists on
 * mobile at all — so this stays narrow rather than inventing a parallel feature set beyond what's asked).
 * Same "first household" simplification emergency-binder.tsx already makes (no multi-household picker
 * exists on mobile yet).
 */
export default function HouseholdScreen() {
  const { theme } = useAppTheme();
  const [household, setHousehold] = useState<MyHousehold | null>(null);
  const [dependents, setDependents] = useState<Dependent[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const households = await api.get<MyHousehold[]>("/v1/households");
      const mine = households[0] ?? null;
      setHousehold(mine);
      if (mine) {
        const deps = await api.get<Dependent[]>(`/v1/households/${mine.household.id}/dependents`);
        setDependents(deps);
      } else {
        setDependents([]);
      }
    } catch (err) {
      setLoadError(apiErrorMessage(err, "Couldn't load your household."));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const canManage = household?.membership.role === "household_owner" || household?.membership.role === "adult_member";

  return (
    <Screen>
      <ScreenHeader title="Household" subtitle="Dependents in your household, and their account status." />

      {loadError && <FetchError what="your household" message={loadError} onRetry={load} />}

      {!loadError && !loading && !household && (
        <EmptyState title="No household yet" description="Create one on the web app to add dependents and share things with your household." />
      )}

      {!loadError && household && dependents && dependents.length === 0 && (
        <EmptyState title="No dependent profiles yet" description="Add one on the web app — for kids or anyone else without their own account." />
      )}

      {!loadError && household && dependents && dependents.length > 0 && (
        <View style={{ gap: 12 }}>
          {dependents.map((d) => (
            <DependentCard key={d.id} householdId={household.household.id} dependent={d} canManage={canManage} onChanged={load} />
          ))}
        </View>
      )}
    </Screen>
  );
}

function DependentCard({
  householdId,
  dependent,
  canManage,
  onChanged,
}: {
  householdId: string;
  dependent: Dependent;
  canManage: boolean;
  onChanged: () => void;
}) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const isPending =
    Boolean(dependent.transitionInviteTokenExpiresAt) && new Date(dependent.transitionInviteTokenExpiresAt as string) > new Date();

  async function onInvite() {
    setLoading(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/dependents/${dependent.id}/invite-transition`, { email });
      setEmail("");
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onRevoke() {
    setRevoking(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/dependents/${dependent.id}/revoke-transition`);
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>{dependent.displayName}</Text>
        {dependent.hasOwnAccount && <Badge tone="positive">Has own account</Badge>}
      </View>

      {!dependent.hasOwnAccount && canManage && (
        <>
          {isPending ? (
            <View style={{ gap: 8 }}>
              <Badge tone="warning">{`Invite sent to ${dependent.transitionInvitedEmail ?? "their email"}`}</Badge>
              <Button variant="ghost" onPress={onRevoke} loading={revoking}>
                Cancel invite
              </Button>
            </View>
          ) : open ? (
            <View style={{ gap: 8 }}>
              <TextField
                label={`${dependent.displayName}'s email`}
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
                placeholder="their-email@example.com"
              />
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                They'll get an emailed link to sign in or create an account. Everything already on their profile stays visible to
                them and the household — this only adds independent sign-in access.
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button onPress={onInvite} loading={loading} disabled={!email}>
                    Send invite
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button variant="secondary" onPress={() => setOpen(false)}>
                    Cancel
                  </Button>
                </View>
              </View>
            </View>
          ) : (
            <Button variant="secondary" onPress={() => setOpen(true)}>
              Transition to their own account
            </Button>
          )}
        </>
      )}

      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}
