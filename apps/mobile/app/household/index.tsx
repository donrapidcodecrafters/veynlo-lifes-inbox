import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { ScreenHeader } from "@/components/screen-header";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";

interface HouseholdRow {
  household: { id: string; name: string };
  membership: { role: string };
}

interface Member {
  id: string;
  userId: string | null;
  role: string;
  relationshipLabel: string | null;
  status: string;
  invitedEmail: string | null;
  displayName: string | null;
}

interface Dependent {
  id: string;
  displayName: string;
  birthDate: string | null;
}

interface Delegation {
  id: string;
  delegateUserId: string;
  delegateDisplayName: string | null;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
}

const DELEGATION_SCOPES = ["schedule:read", "documents:read", "commerce:read", "household:read"] as const;

const ROLE_LABEL: Record<string, string> = {
  household_owner: "Owner",
  adult_member: "Adult member",
};

export default function HouseholdScreen() {
  const { theme } = useAppTheme();
  const [households, setHouseholds] = useState<HouseholdRow[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [dependents, setDependents] = useState<Dependent[] | null>(null);
  const [delegations, setDelegations] = useState<Delegation[] | null>(null);

  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRelationship, setInviteRelationship] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [dependentName, setDependentName] = useState("");
  const [addingDependent, setAddingDependent] = useState(false);

  const [delegateUserId, setDelegateUserId] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [granting, setGranting] = useState(false);
  const [delegationError, setDelegationError] = useState<string | null>(null);

  const active = households?.[0];

  const load = useCallback(async () => {
    const hh = await api.get<HouseholdRow[]>("/v1/households");
    setHouseholds(hh);
    if (hh.length > 0) {
      const householdId = hh[0].household.id;
      const [m, d, dl] = await Promise.all([
        api.get<Member[]>(`/v1/households/${householdId}/members`),
        api.get<Dependent[]>(`/v1/households/${householdId}/dependents`),
        api.get<Delegation[]>(`/v1/households/${householdId}/delegations`),
      ]);
      setMembers(m);
      setDependents(d);
      setDelegations(dl);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function createHousehold() {
    setCreating(true);
    try {
      await api.post("/v1/households", { name: createName });
      setCreateName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  async function invite() {
    if (!active) return;
    setInviting(true);
    setInviteError(null);
    try {
      await api.post(`/v1/households/${active.household.id}/invite`, {
        email: inviteEmail,
        relationshipLabel: inviteRelationship || undefined,
      });
      setInviteEmail("");
      setInviteRelationship("");
      await load();
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : "Couldn't send that invite. Please try again.");
    } finally {
      setInviting(false);
    }
  }

  async function addDependent() {
    if (!active) return;
    setAddingDependent(true);
    try {
      await api.post(`/v1/households/${active.household.id}/dependents`, { displayName: dependentName });
      setDependentName("");
      await load();
    } finally {
      setAddingDependent(false);
    }
  }

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function grantDelegation() {
    if (!active || !delegateUserId) return;
    setGranting(true);
    setDelegationError(null);
    try {
      await api.post(`/v1/households/${active.household.id}/delegations`, { delegateUserId, scopes });
      setDelegateUserId(null);
      setScopes([]);
      await load();
    } catch (err) {
      setDelegationError(err instanceof ApiError ? err.message : "Couldn't grant that delegation. Please try again.");
    } finally {
      setGranting(false);
    }
  }

  async function revokeDelegation(delegationId: string) {
    if (!active) return;
    await api.post(`/v1/households/${active.household.id}/delegations/${delegationId}/revoke`);
    await load();
  }

  if (households && households.length === 0) {
    return (
      <Screen>
        <ScreenHeader title="Household" subtitle="Share access with the people in your life." />
        <Card style={{ gap: 10 }}>
          <TextField label="Household name" value={createName} onChangeText={setCreateName} placeholder="e.g. The Riveras" />
          <Button onPress={createHousehold} loading={creating} disabled={!createName.trim()}>
            Create household
          </Button>
        </Card>
      </Screen>
    );
  }

  if (!active) {
    return (
      <Screen>
        <ScreenHeader title="Household" />
        <View style={{ height: 96, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />
      </Screen>
    );
  }

  const canManage = active.membership.role === "household_owner" || active.membership.role === "adult_member";
  const activeMembers = members?.filter((m) => m.status === "active") ?? [];

  return (
    <Screen>
      <ScreenHeader title={active.household.name} subtitle="Share access with the people in your life." />

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Members</Text>
        <Card style={{ gap: 10 }}>
          {members?.map((m) => (
            <View key={m.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                  {m.displayName ?? m.invitedEmail ?? "Unknown"}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{m.relationshipLabel ?? ROLE_LABEL[m.role] ?? m.role}</Text>
              </View>
              <Badge tone={m.status === "active" ? "positive" : m.status === "invited" ? "warning" : "neutral"}>
                {m.status === "active" ? ROLE_LABEL[m.role] ?? m.role : m.status}
              </Badge>
            </View>
          ))}
        </Card>
        {canManage && (
          <Card style={{ gap: 8 }}>
            <TextField label="Invite by email" value={inviteEmail} onChangeText={setInviteEmail} autoCapitalize="none" keyboardType="email-address" />
            <TextField label="Relationship (optional)" value={inviteRelationship} onChangeText={setInviteRelationship} placeholder="e.g. Spouse" />
            {inviteError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{inviteError}</Text>}
            <Button onPress={invite} loading={inviting} disabled={!inviteEmail.trim()}>
              Invite
            </Button>
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Dependents</Text>
        <Card style={{ gap: 10 }}>
          {dependents?.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No dependents added yet.</Text>}
          {dependents?.map((d) => (
            <Text key={d.id} style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
              {d.displayName}
            </Text>
          ))}
        </Card>
        {canManage && (
          <Card style={{ gap: 8 }}>
            <TextField label="Name" value={dependentName} onChangeText={setDependentName} placeholder="e.g. Sam" />
            <Button onPress={addDependent} loading={addingDependent} disabled={!dependentName.trim()}>
              Add dependent
            </Button>
          </Card>
        )}
      </View>

      <View style={{ gap: 8 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Caregiver delegations</Text>
        <Card style={{ gap: 10 }}>
          {delegations?.filter((d) => !d.revokedAt).length === 0 && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No active delegations yet.</Text>
          )}
          {delegations
            ?.filter((d) => !d.revokedAt)
            .map((d) => (
              <View key={d.id} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{d.delegateDisplayName ?? d.delegateUserId}</Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{d.scopes.join(", ")}</Text>
                </View>
                {canManage && (
                  <Button variant="ghost" onPress={() => revokeDelegation(d.id)}>
                    Revoke
                  </Button>
                )}
              </View>
            ))}
        </Card>
        {canManage && activeMembers.length > 1 && (
          <Card style={{ gap: 10 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Grant access to</Text>
            <View style={{ gap: 6 }}>
              {activeMembers
                .filter((m) => m.userId)
                .map((m) => {
                  const isSelected = delegateUserId === m.userId;
                  return (
                    <Pressable
                      key={m.userId}
                      onPress={() => setDelegateUserId(m.userId)}
                      accessibilityRole="button"
                      accessibilityLabel={m.displayName ?? m.userId ?? "Household member"}
                      accessibilityState={{ selected: isSelected }}
                      style={{
                        padding: 10,
                        borderRadius: theme.radius.sm,
                        backgroundColor: isSelected ? theme.colors.brandDefault : theme.colors.bgSubtle,
                      }}
                    >
                      <Text style={{ fontSize: 13, fontWeight: "600", color: isSelected ? theme.colors.textOnBrand : theme.colors.textPrimary }}>
                        {m.displayName ?? m.userId}
                      </Text>
                    </Pressable>
                  );
                })}
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {DELEGATION_SCOPES.map((scope) => {
                const isSelected = scopes.includes(scope);
                return (
                  <Pressable
                    key={scope}
                    onPress={() => toggleScope(scope)}
                    accessibilityRole="button"
                    accessibilityLabel={scope}
                    accessibilityState={{ selected: isSelected }}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: theme.radius.sm,
                      backgroundColor: isSelected ? theme.colors.brandDefault : theme.colors.bgSubtle,
                    }}
                  >
                    <Text style={{ fontSize: 12, fontWeight: "600", color: isSelected ? theme.colors.textOnBrand : theme.colors.textPrimary }}>
                      {scope}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {delegationError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{delegationError}</Text>}
            <Button onPress={grantDelegation} loading={granting} disabled={!delegateUserId || scopes.length === 0}>
              Grant access
            </Button>
          </Card>
        )}
      </View>
    </Screen>
  );
}
