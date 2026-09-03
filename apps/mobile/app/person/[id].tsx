import { useCallback, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { FetchError } from "@/components/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";
import { PERSON_RELATIONSHIP_SUGGESTIONS, relationshipLabelText } from "@/lib/people";

interface Person {
  id: string;
  ownerUserId: string;
  householdId: string | null;
  displayName: string;
  organizationId: string | null;
  relationshipLabel: string | null;
  relationshipLabelSource: "user_set" | "suggested";
  isImportant: boolean;
  lastContactAt: string | null;
  visibility: "private" | "household" | "selected_people" | "shared_link";
  relatedEntityIds: string[];
}

interface OrganizationRow {
  id: string;
  name: string;
  organizationType: string | null;
}

interface AliasRow {
  id: string;
  kind: "email" | "phone" | "name_variant";
  value: string;
}

interface ContactSourceRow {
  id: string;
  provider: string;
  syncedAt: string | null;
}

interface NoteRow {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

interface ImportantDateRow {
  id: string;
  label: string;
  date: TemporalValueLike;
  isSensitive: boolean;
  reminderDaysBefore: number;
}

interface RelationshipRow {
  id: string;
  fromPersonId: string;
  toPersonId: string | null;
  toDependentProfileId: string | null;
  label: string;
}

// PEO-004 — every linked-history row is a full row from its own domain table (see PeopleService.
// resolveRelatedEntities); only the one display field per kind, plus `id`, is actually used here.
interface LinkedHistory {
  bill: { id: string; billerLabel: string }[];
  document: { id: string; title: string }[];
  maintenanceRecord: { id: string; description: string }[];
  calendarEvent: { id: string; title: string }[];
  task: { id: string; title: string }[];
  warranty: { id: string; productLabel: string }[];
  vehicle: { id: string; label: string }[];
  property: { id: string; label: string }[];
}

interface PersonDetail {
  person: Person;
  organization: OrganizationRow | null;
  aliases: AliasRow[];
  contactSources: ContactSourceRow[];
  notes: NoteRow[];
  importantDates: ImportantDateRow[];
  relationships: { from: RelationshipRow[]; to: RelationshipRow[] };
  linkedHistory: LinkedHistory;
  sharedNote: string | null;
}

interface HouseholdDependent {
  id: string;
  displayName: string;
}

const ALIAS_KIND_LABEL: Record<AliasRow["kind"], string> = { email: "Email", phone: "Phone", name_variant: "Also known as" };

// PEO-004 — which linked-history kinds have their own dedicated mobile detail screen to tap through to.
// "maintenanceRecord" and "task" have no standalone route in this app (their history shows up inline on
// pet/vehicle/property screens and the Life tab respectively), so those two groups render as plain text.
const LINKED_HISTORY_ROUTES: Partial<Record<keyof LinkedHistory, string>> = {
  bill: "/bill",
  document: "/document",
  calendarEvent: "/event",
  warranty: "/warranty",
  vehicle: "/vehicle",
  property: "/property",
};

const LINKED_HISTORY_TITLES: Record<keyof LinkedHistory, string> = {
  bill: "Bills",
  document: "Documents",
  maintenanceRecord: "Maintenance records",
  calendarEvent: "Calendar events",
  task: "Tasks",
  warranty: "Warranties",
  vehicle: "Vehicles",
  property: "Properties",
};

function linkedHistoryLabel(kind: keyof LinkedHistory, row: Record<string, unknown>): string {
  const field = { bill: "billerLabel", document: "title", maintenanceRecord: "description", calendarEvent: "title", task: "title", warranty: "productLabel", vehicle: "label", property: "label" }[kind];
  return typeof row[field] === "string" ? (row[field] as string) : "Untitled";
}

export default function PersonDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<PersonDetail | null | undefined>(undefined);
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [otherPeople, setOtherPeople] = useState<Person[]>([]);
  const [dependents, setDependents] = useState<HouseholdDependent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [savingImportant, setSavingImportant] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [markingContacted, setMarkingContacted] = useState(false);

  // Same "map a 404 to setData(null), everything else to an inline error" fix pet/[id].tsx's own doc
  // comment explains — a bare .then with no .catch on a mount-time fetch becomes an unhandled promise
  // rejection that crashes the whole app on React Native Web.
  const load = useCallback(() => {
    setError(null);
    api
      .get<PersonDetail | null>(`/v1/people/${id}`)
      .then(async (detail) => {
        setData(detail);
        if (!detail) return;
        const [orgs, people] = await Promise.all([
          api.get<OrganizationRow[]>("/v1/organizations").catch(() => []),
          api.get<Person[]>("/v1/people").catch(() => []),
        ]);
        setOrganizations(orgs);
        setOtherPeople(people.filter((p) => p.id !== id));
        if (detail.person.householdId) {
          const deps = await api.get<HouseholdDependent[]>(`/v1/households/${detail.person.householdId}/dependents`).catch(() => []);
          setDependents(deps);
        } else {
          setDependents([]);
        }
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setData(null);
        } else {
          setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again.");
        }
      })
      .finally(() => setRetrying(false));
  }, [id]);

  useFocusEffect(load);

  async function toggleImportant() {
    if (!data) return;
    setSavingImportant(true);
    setActionError(null);
    try {
      await api.patch(`/v1/people/${id}`, { isImportant: !data.person.isImportant });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setSavingImportant(false);
    }
  }

  async function setVisibility(visibility: "private" | "household") {
    setSavingVisibility(true);
    setActionError(null);
    try {
      await api.patch(`/v1/people/${id}/visibility`, { visibility });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update sharing. Please try again.");
    } finally {
      setSavingVisibility(false);
    }
  }

  async function markContacted() {
    setMarkingContacted(true);
    setActionError(null);
    try {
      await api.post(`/v1/people/${id}/record-contact`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this. Please try again.");
    } finally {
      setMarkingContacted(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setActionError(null);
    try {
      await api.delete(`/v1/people/${id}`);
      router.back();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this person. Please try again.");
      setDeleting(false);
    }
  }

  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this person"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) {
    return (
      <Screen>
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This person doesn't exist or you don't have access to them." />
      </Screen>
    );
  }

  const { person, organization } = data;
  const isOwner = true; // Server-side checks are authoritative for every mutation below; this only gates which controls render.
  const subtitle = [organization?.name, person.relationshipLabel ? relationshipLabelText(person.relationshipLabel) : null].filter(Boolean).join(" · ");

  return (
    <Screen>
      <ScreenHeader title={person.displayName} subtitle={subtitle || undefined} />

      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}

      {data.sharedNote && (
        <View style={{ backgroundColor: theme.colors.brandSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ fontSize: 13, color: theme.colors.brandSubtleText }}>Note from the person who shared this: {data.sharedNote}</Text>
        </View>
      )}

      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Important</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Surface this person more prominently.</Text>
          </View>
          <Switch
            value={person.isImportant}
            onValueChange={toggleImportant}
            disabled={savingImportant}
            accessibilityLabel="Important"
            trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
            {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Visible to household</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              Private by default — only you can see this person unless you turn this on{person.householdId ? "" : " (requires adding this person to a household first)"}.
            </Text>
          </View>
          <Switch
            value={person.visibility === "household"}
            onValueChange={(checked) => setVisibility(checked ? "household" : "private")}
            disabled={savingVisibility}
            accessibilityLabel="Visible to household"
            trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
            {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
          />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            {person.lastContactAt ? `Last contact ${new Date(person.lastContactAt).toLocaleDateString()}` : "No contact logged yet"}
          </Text>
          <Button variant="secondary" onPress={markContacted} loading={markingContacted}>
            Mark contacted today
          </Button>
        </View>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <Button variant="ghost" onPress={() => setSharing((s) => !s)}>
            {sharing ? "Hide sharing" : "Share"}
          </Button>
        </View>
        {sharing && <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/people" resourceLabel="person" enableShareLinks={false} enablePreview={false} />}
      </Card>

      <RelationshipLabelEditor person={person} onSaved={load} />

      <OrganizationEditor person={person} organizations={organizations} onSaved={load} />

      <AliasesCard personId={String(id)} aliases={data.aliases} contactSources={data.contactSources} onChanged={load} />

      <NotesCard personId={String(id)} notes={data.notes} onChanged={load} />

      <ImportantDatesCard personId={String(id)} importantDates={data.importantDates} onChanged={load} />

      <RelationshipsCard
        personId={String(id)}
        relationships={data.relationships}
        otherPeople={otherPeople}
        dependents={dependents}
        onChanged={load}
      />

      <LinkedHistoryCard personId={String(id)} linkedHistory={data.linkedHistory} onChanged={load} />

      {!isOwner ? null : confirmingDelete ? (
        <Card style={{ gap: 8, backgroundColor: theme.colors.criticalSubtleBg }}>
          <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
            This removes {person.displayName} and their notes, dates, and relationships. It can&apos;t be undone.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="critical" onPress={remove} loading={deleting}>
                Confirm remove
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </Card>
      ) : (
        <Button variant="secondary" onPress={() => setConfirmingDelete(true)}>
          Remove person
        </Button>
      )}
    </Screen>
  );
}

function RelationshipLabelEditor({ person, onSaved }: { person: Person; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(person.relationshipLabel ?? "");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/people/${person.id}/relationship-label`, { relationshipLabel: label.trim() });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save this. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmSuggestion() {
    setConfirming(true);
    setError(null);
    try {
      await api.post(`/v1/people/${person.id}/relationship-label/confirm`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm this. Please try again.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Relationship</Text>
        {!editing && (
          <Pressable accessibilityRole="button" onPress={() => setEditing(true)}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>Edit</Text>
          </Pressable>
        )}
      </View>
      {!editing ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {person.relationshipLabel ? (
            <Badge tone={person.relationshipLabelSource === "suggested" ? "warning" : "neutral"}>{relationshipLabelText(person.relationshipLabel)}</Badge>
          ) : (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No relationship label set.</Text>
          )}
          {person.relationshipLabelSource === "suggested" && (
            <>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Suggested — not confirmed yet.</Text>
              <Button variant="secondary" onPress={confirmSuggestion} loading={confirming}>
                Confirm
              </Button>
            </>
          )}
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <TextField label="Relationship" placeholder="e.g. dentist, sister" value={label} onChangeText={setLabel} maxLength={60} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {PERSON_RELATIONSHIP_SUGGESTIONS.map((s) => (
              <Pressable accessibilityRole="button"
                key={s}
                onPress={() => setLabel(s)}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.borderSubtle }}
              >
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{relationshipLabelText(s)}</Text>
              </Pressable>
            ))}
          </View>
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={save} loading={saving} disabled={!label.trim()}>
                Save
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setEditing(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

function OrganizationEditor({ person, organizations, onSaved }: { person: Person; organizations: OrganizationRow[]; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [editing, setEditing] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(person.organizationId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (organizations.length === 0 && !person.organizationId) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/people/${person.id}`, { organizationId });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save this. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const current = organizations.find((o) => o.id === person.organizationId);

  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Organization</Text>
        {!editing && (
          <Pressable accessibilityRole="button" onPress={() => setEditing(true)}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>Edit</Text>
          </Pressable>
        )}
      </View>
      {!editing ? (
        <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{current?.name ?? "None"}</Text>
      ) : (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Pressable accessibilityRole="button"
              onPress={() => setOrganizationId(null)}
              style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: organizationId === null ? theme.colors.brandDefault : theme.colors.borderSubtle }}
            >
              <Text style={{ fontSize: 12, color: organizationId === null ? theme.colors.brandDefault : theme.colors.textTertiary }}>None</Text>
            </Pressable>
            {organizations.map((o) => (
              <Pressable accessibilityRole="button"
                key={o.id}
                onPress={() => setOrganizationId(o.id)}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: organizationId === o.id ? theme.colors.brandDefault : theme.colors.borderSubtle }}
              >
                <Text style={{ fontSize: 12, color: organizationId === o.id ? theme.colors.brandDefault : theme.colors.textTertiary }}>{o.name}</Text>
              </Pressable>
            ))}
          </View>
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={save} loading={saving}>
                Save
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setEditing(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

function AliasesCard({ personId, aliases, contactSources, onChanged }: { personId: string; aliases: AliasRow[]; contactSources: ContactSourceRow[]; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<AliasRow["kind"]>("email");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!value.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/aliases`, { kind, value: value.trim() });
      setValue("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(aliasId: string) {
    try {
      await api.delete(`/v1/people/aliases/${aliasId}`);
      onChanged();
    } catch {
      // Best-effort — the row just stays if this fails; the user can retry.
    }
  }

  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Emails & phone numbers</Text>
      {/* PEO-001 "Contact sources remain evidence" — a small provider trail, distinct from the aliases the
          user can edit directly below. */}
      {contactSources.length > 0 && (
        <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
          Added via: {contactSources.map((s) => s.provider).join(", ")}
        </Text>
      )}
      {aliases.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None recorded yet.</Text>}
      {aliases.map((a) => (
        <View key={a.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Badge tone="neutral">{ALIAS_KIND_LABEL[a.kind]}</Badge>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{a.value}</Text>
          </View>
          <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.critical }} onPress={() => remove(a.id)}>
            Remove
          </Text>
        </View>
      ))}
      {!adding ? (
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add an email/phone</Text>
        </Pressable>
      ) : (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 6 }}>
            {(["email", "phone", "name_variant"] as const).map((k) => (
              <Pressable accessibilityRole="button"
                key={k}
                onPress={() => setKind(k)}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: kind === k ? theme.colors.brandDefault : theme.colors.borderSubtle }}
              >
                <Text style={{ fontSize: 12, color: kind === k ? theme.colors.brandDefault : theme.colors.textTertiary }}>{ALIAS_KIND_LABEL[k]}</Text>
              </Pressable>
            ))}
          </View>
          <TextField
            label="Value"
            value={value}
            onChangeText={setValue}
            autoCapitalize="none"
            keyboardType={kind === "email" ? "email-address" : kind === "phone" ? "phone-pad" : "default"}
          />
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={add} loading={submitting} disabled={!value.trim()}>
                Add
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setAdding(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

function NotesCard({ personId, notes, onChanged }: { personId: string; notes: NoteRow[]; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [adding, setAdding] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/notes`, { body: body.trim() });
      setBody("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this note. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(noteId: string) {
    try {
      await api.delete(`/v1/people/notes/${noteId}`);
      onChanged();
    } catch {
      // Best-effort — the row just stays if this fails; the user can retry.
    }
  }

  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Notes</Text>
      {notes.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No notes yet.</Text>}
      {notes.map((n) => (
        <View key={n.id} style={{ paddingVertical: 4, gap: 2 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{n.body}</Text>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>{new Date(n.createdAt).toLocaleDateString()}</Text>
            <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.critical }} onPress={() => remove(n.id)}>
              Delete
            </Text>
          </View>
        </View>
      ))}
      {!adding ? (
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a note</Text>
        </Pressable>
      ) : (
        <View style={{ gap: 8 }}>
          <TextField label="Note" value={body} onChangeText={setBody} multiline numberOfLines={3} maxLength={5000} style={{ height: 88, textAlignVertical: "top", paddingTop: 12 }} />
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={add} loading={submitting} disabled={!body.trim()}>
                Add
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setAdding(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

/** PEO-005 — `isSensitive` dates never come back from the server for anyone but the owner (see
 * PeopleService.detail's own filter), so this card doesn't need its own visibility check on top of that. */
function ImportantDatesCard({ personId, importantDates, onChanged }: { personId: string; importantDates: ImportantDateRow[]; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [dateIso, setDateIso] = useState("");
  const [isSensitive, setIsSensitive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!label.trim() || !dateIso) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/important-dates`, { label: label.trim(), dateIso, isSensitive });
      setLabel("");
      setDateIso("");
      setIsSensitive(false);
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this date. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(dateId: string) {
    try {
      await api.delete(`/v1/people/important-dates/${dateId}`);
      onChanged();
    } catch {
      // Best-effort — the row just stays if this fails; the user can retry.
    }
  }

  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Important dates</Text>
      {importantDates.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None recorded yet.</Text>}
      {importantDates.map((d) => {
        const when = formatTemporal(d.date);
        return (
          <View key={d.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{d.label}</Text>
              {when && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{when}</Text>}
              {d.isSensitive && <Badge tone="neutral">Private</Badge>}
            </View>
            <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.critical }} onPress={() => remove(d.id)}>
              Delete
            </Text>
          </View>
        );
      })}
      {!adding ? (
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add an important date</Text>
        </Pressable>
      ) : (
        <View style={{ gap: 8 }}>
          <TextField label="Label" placeholder="e.g. Birthday" value={label} onChangeText={setLabel} maxLength={80} />
          <TextField label="Date (YYYY-MM-DD)" value={dateIso} onChangeText={setDateIso} placeholder="2026-10-20" />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary, flex: 1 }}>
              Keep private even if this person is shared with your household
            </Text>
            <Switch
              value={isSensitive}
              onValueChange={setIsSensitive}
              accessibilityLabel="Keep private even if this person is shared with your household"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={add} loading={submitting} disabled={!label.trim() || !dateIso}>
                Add
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setAdding(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

function RelationshipsCard({
  personId,
  relationships,
  otherPeople,
  dependents,
  onChanged,
}: {
  personId: string;
  relationships: { from: RelationshipRow[]; to: RelationshipRow[] };
  otherPeople: Person[];
  dependents: HouseholdDependent[];
  onChanged: () => void;
}) {
  const { theme } = useAppTheme();
  const [adding, setAdding] = useState(false);
  const [targetKind, setTargetKind] = useState<"person" | "dependent">("person");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peopleById = new Map(otherPeople.map((p) => [p.id, p.displayName]));
  const dependentsById = new Map(dependents.map((d) => [d.id, d.displayName]));

  function targetName(r: RelationshipRow): string {
    if (r.toPersonId) return peopleById.get(r.toPersonId) ?? "Someone else";
    if (r.toDependentProfileId) return dependentsById.get(r.toDependentProfileId) ?? "A household member";
    return "Unknown";
  }

  async function remove(relationshipId: string) {
    try {
      await api.delete(`/v1/people/relationships/${relationshipId}`);
      onChanged();
    } catch {
      // Best-effort — the row just stays if this fails; the user can retry.
    }
  }

  async function add() {
    if (!targetId || !label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/relationships`, {
        toPersonId: targetKind === "person" ? targetId : undefined,
        toDependentProfileId: targetKind === "dependent" ? targetId : undefined,
        label: label.trim(),
      });
      setTargetId(null);
      setLabel("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this relationship. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const candidates = targetKind === "person" ? otherPeople.map((p) => ({ id: p.id, name: p.displayName })) : dependents.map((d) => ({ id: d.id, name: d.displayName }));

  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Relationships</Text>
      {relationships.from.length === 0 && relationships.to.length === 0 && (
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None recorded yet.</Text>
      )}
      {relationships.from.map((r) => (
        <View key={r.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
            Is <Text style={{ fontWeight: "600" }}>{relationshipLabelText(r.label)}</Text> to {targetName(r)}
          </Text>
          <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.critical }} onPress={() => remove(r.id)}>
            Remove
          </Text>
        </View>
      ))}
      {relationships.to.map((r) => (
        <View key={r.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
            {peopleById.get(r.fromPersonId) ?? "Someone else"} is <Text style={{ fontWeight: "600" }}>{relationshipLabelText(r.label)}</Text> to this person
          </Text>
          <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.critical }} onPress={() => remove(r.id)}>
            Remove
          </Text>
        </View>
      ))}
      {!adding ? (
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a relationship</Text>
        </Pressable>
      ) : (
        <View style={{ gap: 8 }}>
          {dependents.length > 0 && (
            <View style={{ flexDirection: "row", gap: 6 }}>
              {(["person", "dependent"] as const).map((k) => (
                <Pressable accessibilityRole="button"
                  key={k}
                  onPress={() => {
                    setTargetKind(k);
                    setTargetId(null);
                  }}
                  style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: targetKind === k ? theme.colors.brandDefault : theme.colors.borderSubtle }}
                >
                  <Text style={{ fontSize: 12, color: targetKind === k ? theme.colors.brandDefault : theme.colors.textTertiary }}>
                    {k === "person" ? "Another person" : "Household member"}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {candidates.length === 0 ? (
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              {targetKind === "person" ? "Add another person first to link them here." : "No household members found."}
            </Text>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {candidates.map((c) => (
                <Pressable accessibilityRole="button"
                  key={c.id}
                  onPress={() => setTargetId(c.id)}
                  style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: targetId === c.id ? theme.colors.brandDefault : theme.colors.borderSubtle }}
                >
                  <Text style={{ fontSize: 12, color: targetId === c.id ? theme.colors.brandDefault : theme.colors.textTertiary }}>{c.name}</Text>
                </Pressable>
              ))}
            </View>
          )}
          <TextField label="Relationship" placeholder="e.g. dentist, sister, coach" value={label} onChangeText={setLabel} maxLength={80} />
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={add} loading={submitting} disabled={!targetId || !label.trim()}>
                Add
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setAdding(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}

/** PEO-004 "Provider/contractor history" generic linking — grouped by kind, tapping through to whichever
 * kinds have a dedicated detail screen in this app (see LINKED_HISTORY_ROUTES). Adding a link is a raw-id
 * field rather than a search picker — this app has no cross-domain item search/picker component yet, and
 * the id itself is stable/copyable from each item's own detail screen. */
function LinkedHistoryCard({ personId, linkedHistory, onChanged }: { personId: string; linkedHistory: LinkedHistory; onChanged: () => void }) {
  const { theme } = useAppTheme();
  const [adding, setAdding] = useState(false);
  const [entityId, setEntityId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kinds = Object.keys(linkedHistory) as (keyof LinkedHistory)[];
  const anyLinked = kinds.some((k) => linkedHistory[k].length > 0);

  async function add() {
    if (!entityId.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/linked-entities`, { entityId: entityId.trim() });
      setEntityId("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that item. Make sure the id is correct and belongs to you.");
    } finally {
      setSubmitting(false);
    }
  }

  async function unlink(entId: string) {
    try {
      await api.delete(`/v1/people/${personId}/linked-entities/${entId}`);
      onChanged();
    } catch {
      // Best-effort — the row just stays if this fails; the user can retry.
    }
  }

  return (
    <Card style={{ gap: 6 }}>
      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Linked history</Text>
      {!anyLinked && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No bills, documents, or other items linked yet.</Text>}
      {kinds.map((kind) => {
        const rows = linkedHistory[kind];
        if (rows.length === 0) return null;
        const routeBase = LINKED_HISTORY_ROUTES[kind];
        return (
          <View key={kind} style={{ gap: 4 }}>
            <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary }}>{LINKED_HISTORY_TITLES[kind]}</Text>
            {rows.map((row) => {
              const label = linkedHistoryLabel(kind, row as unknown as Record<string, unknown>);
              const rowId = (row as { id: string }).id;
              return (
                <View key={rowId} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 2 }}>
                  {routeBase ? (
                    <Pressable accessibilityRole="button" onPress={() => router.push(`${routeBase}/${rowId}`)} style={{ flex: 1 }}>
                      <Text style={{ fontSize: 13, color: theme.colors.brandDefault }}>{label}</Text>
                    </Pressable>
                  ) : (
                    <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{label}</Text>
                  )}
                  <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.critical }} onPress={() => unlink(rowId)}>
                    Unlink
                  </Text>
                </View>
              );
            })}
          </View>
        );
      })}
      {!adding ? (
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Link an item by id</Text>
        </Pressable>
      ) : (
        <View style={{ gap: 8 }}>
          <TextField label="Item id" placeholder="e.g. bill_..., document_..., warranty_..." value={entityId} onChangeText={setEntityId} autoCapitalize="none" />
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={add} loading={submitting} disabled={!entityId.trim()}>
                Link
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setAdding(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Card>
  );
}
