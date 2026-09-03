import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
// PEO-001 "Apple Contacts / local device address book" — Apple (and, for this purpose, Android) have no
// server-side Contacts API a backend could OAuth into and poll; a device's own local address book can only
// be read on-device, through this native module, then pushed up explicitly by the app. Imported from
// "expo-contacts/legacy" deliberately: the plain "expo-contacts" entrypoint now resolves to a new
// class-based API (`Contact.getAll()`/etc.), and re-exports the OLD function names — including
// `getContactsAsync`, `requestPermissionsAsync` — only as deprecated stubs that unconditionally throw at
// runtime (see expo-contacts' own src/legacyWarnings.ts). This is the exact same "new object-oriented API
// under the plain package name, old function API still real but relocated" migration connections.tsx's
// syncDeviceCalendar already documented for expo-calendar — confirmed here by reading expo-contacts@57's
// own source rather than assumed.
import * as Contacts from "expo-contacts/legacy";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface PickableContact {
  id: string;
  name: string;
  subtitle: string | null;
  emails: string[];
  phones: string[];
}

type Stage = "checking" | "explain" | "denied" | "loading" | "picking" | "importing" | "done";

/**
 * §14 "Contacts, People & Relationships" (PEO-001) — the one-time "Import from this device" flow. PEO-001
 * is explicit: "Import selected/all contacts according to user choice ... never automatically upload the
 * entire device address book without explicit consent." So this never reads contacts until the user asks,
 * never sends anything to the server until the user has checked specific rows and tapped Import, and
 * defaults every row to UNCHECKED (there's a "Select all" affordance, but it's an explicit tap, not a
 * pre-checked default) — the same "conservative, always human-reviewed" posture PEO-002's merge review
 * (person/merge.tsx) takes for a different reason.
 *
 * Each selected contact becomes one `POST /v1/people` call with its name/emails/phones inline — the
 * `CreatePersonDtoSchema` (services/api/src/modules/people/dto.ts) already accepts `emails`/`phones`
 * arrays directly, so this never needs a second per-alias request. `source: "apple_local"` on that same
 * call tells `PeopleService.create` to stamp the resulting `contactSources` row with `provider:
 * "apple_local"` instead of its "manual" default, preserving "this came from the user's own local address
 * book" provenance the same way "google"/"microsoft" already do for their own connector imports.
 */
export default function ImportDeviceContactsScreen() {
  const { theme } = useAppTheme();
  const [stage, setStage] = useState<Stage>("checking");
  const [canAskAgain, setCanAskAgain] = useState(true);
  const [contacts, setContacts] = useState<PickableContact[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ imported: number; failed: number } | null>(null);

  const checkPermission = useCallback(async () => {
    setStage("checking");
    try {
      const current = await Contacts.getPermissionsAsync();
      if (current.status === "granted") {
        await loadContacts();
      } else {
        setCanAskAgain(current.canAskAgain);
        setStage(current.status === "denied" && !current.canAskAgain ? "denied" : "explain");
      }
    } catch {
      setLoadError("Couldn't check your contacts permission. Please try again.");
      setStage("explain");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    checkPermission();
  }, [checkPermission]);

  async function requestAccess() {
    setStage("checking");
    setLoadError(null);
    try {
      const result = await Contacts.requestPermissionsAsync();
      if (result.status === "granted") {
        await loadContacts();
      } else {
        setCanAskAgain(result.canAskAgain);
        setStage(result.canAskAgain ? "explain" : "denied");
      }
    } catch {
      setLoadError("Couldn't request contacts access. Please try again.");
      setStage("explain");
    }
  }

  async function loadContacts() {
    setStage("loading");
    setLoadError(null);
    try {
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Emails, Contacts.Fields.PhoneNumbers, Contacts.Fields.Name],
        sort: Contacts.SortTypes.FirstName,
      });
      const picked: PickableContact[] = data
        .map((c): PickableContact | null => {
          const name = (c.name || "").trim();
          if (!name) return null; // Nothing usable to show/send as displayName — skip rather than import "Unnamed".
          const emails = (c.emails ?? []).map((e) => e.email).filter((e): e is string => Boolean(e));
          const phones = (c.phoneNumbers ?? []).map((p) => p.number).filter((p): p is string => Boolean(p));
          const subtitle = emails[0] ?? phones[0] ?? null;
          return { id: c.id, name, subtitle, emails, phones };
        })
        .filter((c): c is PickableContact => c !== null);
      setContacts(picked);
      setStage("picking");
    } catch {
      setLoadError("Couldn't read your contacts. Please try again.");
      setStage("explain");
    }
  }

  function toggle(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contacts, query]);

  async function importSelected() {
    const toImport = contacts.filter((c) => selectedIds.has(c.id));
    if (toImport.length === 0) return;
    setStage("importing");
    let imported = 0;
    let failed = 0;
    for (const contact of toImport) {
      try {
        await api.post("/v1/people", { displayName: contact.name, emails: contact.emails, phones: contact.phones, source: "apple_local" });
        imported += 1;
      } catch {
        failed += 1;
      }
    }
    setImportResult({ imported, failed });
    setStage("done");
  }

  if (stage === "checking") {
    return (
      <Screen>
        <ScreenHeader title="Import from this device" />
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }

  if (stage === "denied" || stage === "explain") {
    return (
      <Screen>
        <ScreenHeader title="Import from this device" />
        <EmptyState
          title={stage === "denied" ? "Contacts access is off" : "Bring in people from your address book"}
          description={
            stage === "denied"
              ? "You've turned off contacts access for Veynlo. Turn it on in your device settings, then come back here."
              : "Veynlo will show you your device contacts so you can pick which ones to bring in. Nothing is imported until you choose and confirm — your full address book is never uploaded automatically."
          }
        />
        {loadError && <Text style={{ fontSize: 13, color: theme.colors.critical, textAlign: "center" }}>{loadError}</Text>}
        {stage === "denied" ? (
          <Button onPress={() => Linking.openSettings()}>Open device settings</Button>
        ) : (
          <Button onPress={requestAccess}>{canAskAgain ? "Allow contacts access" : "Try again"}</Button>
        )}
      </Screen>
    );
  }

  if (stage === "loading") {
    return (
      <Screen>
        <ScreenHeader title="Import from this device" />
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }

  if (stage === "done") {
    return (
      <Screen>
        <ScreenHeader title="Import from this device" />
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
            Imported {importResult?.imported ?? 0} {importResult?.imported === 1 ? "person" : "people"}.
          </Text>
          {importResult && importResult.failed > 0 && (
            <Text style={{ fontSize: 13, color: theme.colors.critical }}>
              {importResult.failed} {importResult.failed === 1 ? "contact" : "contacts"} couldn&apos;t be imported. You can try again from Connections.
            </Text>
          )}
        </Card>
        <Button onPress={() => router.back()}>Done</Button>
      </Screen>
    );
  }

  // stage === "picking" / "importing"
  return (
    <Screen>
      <ScreenHeader
        title="Import from this device"
        subtitle={`${selectedIds.size} of ${contacts.length} selected — only checked contacts are imported.`}
      />
      <TextField label="Search" placeholder="Filter by name" value={query} onChangeText={setQuery} autoCapitalize="none" />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Pressable onPress={() => setSelectedIds(new Set(filtered.map((c) => c.id)))} accessibilityRole="button">
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>Select all shown</Text>
        </Pressable>
        <Pressable onPress={() => setSelectedIds(new Set())} accessibilityRole="button">
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textTertiary }}>Clear</Text>
        </Pressable>
      </View>

      {filtered.length === 0 && <EmptyState title="No contacts found" description="Try a different search, or go back and check a different device account." />}

      {filtered.length > 0 && (
        <Card style={{ padding: 0 }}>
          {filtered.map((c, i) => {
            const checked = selectedIds.has(c.id);
            return (
              <Pressable
                key={c.id}
                onPress={() => toggle(c.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={c.name}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: theme.colors.borderSubtle,
                }}
              >
                <View
                  importantForAccessibility="no"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    borderWidth: 2,
                    borderColor: checked ? theme.colors.brandDefault : theme.colors.borderDefault,
                    backgroundColor: checked ? theme.colors.brandDefault : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {checked && <Text style={{ color: theme.colors.textOnBrand, fontSize: 14, fontWeight: "700" }}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{c.name}</Text>
                  {c.subtitle && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{c.subtitle}</Text>}
                </View>
              </Pressable>
            );
          })}
        </Card>
      )}

      <Button onPress={importSelected} loading={stage === "importing"} disabled={selectedIds.size === 0}>
        {selectedIds.size > 0 ? `Import ${selectedIds.size} selected` : "Select contacts to import"}
      </Button>
    </Screen>
  );
}
