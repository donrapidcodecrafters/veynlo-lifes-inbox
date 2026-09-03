import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useOfflineMutationQueue } from "@/lib/offline-mutation-queue";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { FetchError } from "@/components/fetch-error";

interface SavedItem {
  id: string;
  createdByUserId: string;
  label: string;
  checked: boolean;
  assignedToUserId: string | null;
  isPrivate: boolean;
}
interface ListDetail {
  list: { id: string; name: string; ownerUserId: string; householdId: string | null };
  items: SavedItem[];
}
interface Membership {
  userId: string | null;
  relationshipLabel: string | null;
  invitedEmail: string | null;
  status: "invited" | "active" | "left" | "removed";
}

function memberLabel(m: Membership): string {
  return m.relationshipLabel ?? m.invitedEmail ?? "Household member";
}

/** Mirrors apps/web's (app)/lists/[id]/page.tsx. */
export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [data, setData] = useState<ListDetail | null | undefined>(undefined);
  const [members, setMembers] = useState<Membership[]>([]);
  const [label, setLabel] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [adding, setAdding] = useState(false);
  // Inline confirm/picker state, not RN's Alert.alert: react-native-web's Alert.alert is a permanent no-op
  // stub (`class Alert { static alert() {} }`, confirmed live — tapping "Delete list" or an assignment
  // control under `expo start --web` did nothing at all, no dialog, no error). Every other
  // destructive-confirm or multi-choice flow already in this app (settings.tsx's delete-account,
  // connections.tsx's disconnect+delete-data, lists.tsx's own household-picker chips) uses inline
  // Card/Pressable state instead of Alert for exactly this reason — matching that convention here also
  // makes this actually work in the web preview, not just on native.
  const [confirmingDeleteList, setConfirmingDeleteList] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [assigningItemId, setAssigningItemId] = useState<string | null>(null);
  // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx, lists.tsx, etc.): an unguarded
  // fetch/mutation becomes an unhandled promise rejection on any transient network failure, which React
  // Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just
  // this screen. `load()` runs fire-and-forget from `useFocusEffect` below, so there's nowhere else to
  // catch it; the item mutations are user-initiated but would crash just as hard on a flaky connection.
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  // §42.6 "Offline sync and conflict model" — `addItem` has no server-assigned id to key a real row on
  // until it actually syncs, so a queued add is tracked as its own local placeholder row instead of trying
  // to graft it onto `items`. `queuedCheckedIds` is simpler: `toggleChecked` mutates an EXISTING item, so
  // it only needs to remember which real item id is waiting on which idempotency key.
  const [pendingAdds, setPendingAdds] = useState<Array<{ idempotencyKey: string; label: string; isPrivate: boolean }>>([]);
  const [queuedCheckedIds, setQueuedCheckedIds] = useState<Record<string, string>>({});
  const { entries: queueEntries } = useOfflineMutationQueue();
  const settledQueueKeysRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const detail = await api.get<ListDetail>(`/v1/lists/${id}`);
      setData(detail);
      setMembers(detail.list.householdId ? await api.get<Membership[]>(`/v1/households/${detail.list.householdId}/members`) : []);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load this list. Please try again.");
    } finally {
      setRetrying(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // §42.6 — reconciles both kinds of queued mutation against the live queue: a synced/failed entry is no
  // longer "queued" from this screen's point of view, one way or the other. A synced add means the server
  // now has the real row, so its placeholder comes out and `load()` picks up the authoritative version; a
  // synced check just needs a reload to confirm; either kind failing (non-network rejection, or a
  // conflict — e.g. the item was deleted from another device while this was queued) needs `error` set so
  // it isn't silently lost.
  useEffect(() => {
    if (pendingAdds.length === 0 && Object.keys(queuedCheckedIds).length === 0) return;
    let anySettled = false;
    let failureMessage: string | null = null;

    const stillPendingAdds = pendingAdds.filter((pending) => {
      const entry = queueEntries.find((e) => e.id === pending.idempotencyKey);
      if (entry && entry.status !== "failed") return true;
      if (!settledQueueKeysRef.current.has(pending.idempotencyKey)) {
        settledQueueKeysRef.current.add(pending.idempotencyKey);
        anySettled = true;
        if (entry?.status === "failed") failureMessage = entry.conflict ? `Couldn't add "${pending.label}" — this list may have changed. Please check and try again.` : `Couldn't add "${pending.label}". Please try again.`;
      }
      return false;
    });
    if (stillPendingAdds.length !== pendingAdds.length) setPendingAdds(stillPendingAdds);

    const nextQueuedChecked = { ...queuedCheckedIds };
    for (const [itemId, idempotencyKey] of Object.entries(queuedCheckedIds)) {
      const entry = queueEntries.find((e) => e.id === idempotencyKey);
      if (entry && entry.status !== "failed") continue;
      if (!settledQueueKeysRef.current.has(idempotencyKey)) {
        settledQueueKeysRef.current.add(idempotencyKey);
        anySettled = true;
        if (entry?.status === "failed") failureMessage = entry.conflict ? "Couldn't update that item — it may have changed elsewhere. Please check and try again." : "Couldn't update that item. Please try again.";
      }
      delete nextQueuedChecked[itemId];
    }
    if (Object.keys(nextQueuedChecked).length !== Object.keys(queuedCheckedIds).length) setQueuedCheckedIds(nextQueuedChecked);

    if (anySettled) {
      if (failureMessage) setError(failureMessage);
      load();
    }
  }, [queueEntries, pendingAdds, queuedCheckedIds, load]);

  async function addItem() {
    setAdding(true);
    setError(null);
    const submittedLabel = label;
    try {
      const result = await api.postQueueable(`/v1/lists/${id}/items`, { label, isPrivate }, `Add "${label}"`);
      setLabel("");
      setIsPrivate(false);
      if (result.queued) {
        setPendingAdds((prev) => [...prev, { idempotencyKey: result.idempotencyKey, label: submittedLabel, isPrivate }]);
      } else {
        await load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that item. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  async function doAssign(itemId: string, assignedToUserId: string | null) {
    try {
      await api.put(`/v1/lists/items/${itemId}`, { assignedToUserId });
      setAssigningItemId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the assignment. Please try again.");
    }
  }

  async function toggleChecked(item: SavedItem) {
    try {
      const result = await api.putQueueable(`/v1/lists/items/${item.id}`, { checked: !item.checked }, item.checked ? "Mark unchecked" : "Mark checked");
      if (result.queued) {
        setQueuedCheckedIds((m) => ({ ...m, [item.id]: result.idempotencyKey }));
      } else {
        await load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that item. Please try again.");
    }
  }

  async function deleteItem(itemId: string) {
    try {
      await api.delete(`/v1/lists/items/${itemId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that item. Please try again.");
    }
  }

  async function confirmDeleteList() {
    try {
      await api.delete(`/v1/lists/${id}`);
      router.replace("/lists");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this list. Please try again.");
    }
  }

  if (data === undefined && error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this list"
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
      </Screen>
    );
  }

  const { list, items } = data;
  const isOwner = user?.id === list.ownerUserId;

  return (
    <Screen>
      <ScreenHeader title={list.name} subtitle={list.householdId ? "Shared with your household" : "Private"} />
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}

      <Card style={{ gap: 10 }}>
        <TextField label="Add an item" placeholder="e.g. Milk" value={label} onChangeText={setLabel} />
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Private</Text>
          {/* `activeThumbColor` isn't part of RN's typed SwitchProps (native ignores unknown props harmlessly)
              but react-native-web reads it — without it, the web preview's ON-state thumb falls back to
              RNW's own hardcoded teal (`#009688`), clashing with the brand-purple track set above. Confirmed
              live: `trackColor` alone left the track purple but the thumb an off-brand green. */}
          <Switch
            value={isPrivate}
            onValueChange={setIsPrivate}
            accessibilityLabel="Private"
            trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
            {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
          />
        </View>
        <Button onPress={addItem} loading={adding} disabled={!label.trim()}>
          Add
        </Button>
      </Card>

      <View style={{ gap: 8 }}>
        {items.map((item) => {
          const canManage = isOwner || item.createdByUserId === user?.id;
          const activeMembers = members.filter((m) => m.status === "active" && m.userId);
          const assignee = activeMembers.find((m) => m.userId === item.assignedToUserId);
          const isAssigning = assigningItemId === item.id;
          // §42.6 — an optimistic "will end up checked/unchecked like this" flag while this item's toggle
          // is queued: `queuedCheckedIds` only records intent (there's no separate optimistic value stored),
          // so what's shown is simply the opposite of the item's last known server state.
          const queuedChecked = item.id in queuedCheckedIds;
          const displayChecked = queuedChecked ? !item.checked : item.checked;
          return (
            <Card key={item.id} style={{ gap: 10 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <Pressable
                  onPress={() => toggleChecked(item)}
                  hitSlop={8}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: displayChecked }}
                  accessibilityLabel={item.label}
                >
                  {/* Icon-only otherwise — no visible text at all, just this colored square — so without
                      the props above a screen reader user would have no way to tell this exists, let alone
                      what it does or whether it's currently checked. */}
                  <View
                    importantForAccessibility="no"
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      borderWidth: 2,
                      borderColor: displayChecked ? theme.colors.brandDefault : theme.colors.borderDefault,
                      backgroundColor: displayChecked ? theme.colors.brandDefault : "transparent",
                      opacity: queuedChecked ? 0.6 : 1,
                    }}
                  />
                </Pressable>
                <Text
                  style={{
                    flex: 1,
                    minWidth: 80,
                    fontSize: 14,
                    color: displayChecked ? theme.colors.textTertiary : theme.colors.textPrimary,
                    textDecorationLine: displayChecked ? "line-through" : "none",
                  }}
                >
                  {item.label}
                </Text>
                {item.isPrivate && <Badge tone="neutral">Private</Badge>}
                {queuedChecked && <Badge tone="neutral">Queued</Badge>}
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 16 }}>
                {activeMembers.length > 0 && canManage && (
                  <Pressable
                    onPress={() => setAssigningItemId(isAssigning ? null : item.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Assign ${item.label}`}
                    accessibilityState={{ expanded: isAssigning }}
                  >
                    <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{assignee ? memberLabel(assignee) : "Unassigned"}</Text>
                  </Pressable>
                )}
                {canManage && (
                  <Pressable onPress={() => deleteItem(item.id)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${item.label}`}>
                    <Text style={{ fontSize: 13, color: theme.colors.critical }}>Remove</Text>
                  </Pressable>
                )}
              </View>
              {isAssigning && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
                  <Pressable
                    onPress={() => doAssign(item.id, null)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: !item.assignedToUserId }}
                    style={{
                      paddingVertical: 6,
                      paddingHorizontal: 12,
                      borderRadius: 999,
                      backgroundColor: !item.assignedToUserId ? theme.colors.brandDefault : theme.colors.bgSubtle,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "600", color: !item.assignedToUserId ? "#fff" : theme.colors.textSecondary }}>
                      Unassigned
                    </Text>
                  </Pressable>
                  {activeMembers.map((m) => {
                    const active = item.assignedToUserId === m.userId;
                    return (
                      <Pressable
                        key={m.userId}
                        onPress={() => doAssign(item.id, m.userId!)}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        style={{
                          paddingVertical: 6,
                          paddingHorizontal: 12,
                          borderRadius: 999,
                          backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                        }}
                      >
                        <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{memberLabel(m)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </Card>
          );
        })}
        {/* §42.6 "offline command ... remains visibly Pending until server confirms" — a queued `addItem`
            has no server-assigned id/row to render inline with `items` above, so it gets its own
            placeholder card instead: not interactive (nothing to check/assign/remove on a row that doesn't
            exist server-side yet), just a visible acknowledgment the add wasn't lost. */}
        {pendingAdds.map((pending) => (
          <Card key={pending.idempotencyKey} style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <Text style={{ flex: 1, minWidth: 80, fontSize: 14, color: theme.colors.textTertiary }}>{pending.label}</Text>
              {pending.isPrivate && <Badge tone="neutral">Private</Badge>}
              <Badge tone="neutral">Queued — will sync</Badge>
            </View>
          </Card>
        ))}
      </View>

      {/* Phase 2 §52.2 "object sharing" — mirrors apps/web's lists/[id]/page.tsx, which gates Share on
          isOwner because this detail payload actually carries an ownership signal (list.ownerUserId), same
          as the destructive "Delete list" action below. The other three detail screens this feature was
          wired into (purchase/property/vehicle) don't return an owner id in their payload, so those follow
          documents.tsx's precedent instead: always show the button, let the backend's 403 gate it. */}
      {isOwner && !confirmingDeleteList && (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button variant="ghost" onPress={() => setSharing((s) => !s)}>
            Share
          </Button>
          <Button variant="ghost" onPress={() => setConfirmingDeleteList(true)}>
            Delete list
          </Button>
        </View>
      )}

      {isOwner && sharing && (
        <Card>
          <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/lists" resourceLabel="list" />
        </Card>
      )}

      {isOwner && confirmingDeleteList && (
        <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>This removes the list and all its items. It can&apos;t be undone.</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="critical" onPress={confirmDeleteList}>
                Delete list
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setConfirmingDeleteList(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Screen>
  );
}
