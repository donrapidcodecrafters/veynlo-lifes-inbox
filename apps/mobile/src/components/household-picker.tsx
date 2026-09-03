import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";

export interface MyHousehold {
  household: { id: string; name: string };
}

interface HouseholdPickerBaseProps {
  /** Defaults to "Share with" — override for a screen-specific label if needed. */
  label?: string;
}

interface CreateModeProps extends HouseholdPickerBaseProps {
  mode: "create";
  value: string | null;
  onChange: (householdId: string | null) => void;
}

interface EditModeProps extends HouseholdPickerBaseProps {
  mode: "edit";
  value: string | null;
  /** Called immediately on tap, mirroring person/[id].tsx's private/household toggle — the caller is
   * expected to PUT/PATCH the resource and refresh its own data; this component just reports the tap and
   * shows a busy/error state around it. */
  onSave: (householdId: string | null) => Promise<void>;
}

type HouseholdPickerProps = CreateModeProps | EditModeProps;

/**
 * Reusable "private vs. shared with household" chip row — wraps the interaction that lists.tsx originated
 * (its "Just me" / household chips) and person/[id].tsx's edit-time immediate-save toggle, so vehicle/
 * property/pet create forms and detail screens don't each reimplement it. Self-fetches `GET /v1/households`
 * so call sites don't need to plumb that list through themselves.
 *
 * Renders nothing while loading and nothing at all if the user has no households — same as lists.tsx's
 * `households.length > 0` guard, since there's nothing to choose between private and a single "Just me".
 *
 * Create-mode default logic (only ever applied once, only in "create" mode): exactly one household defaults
 * the picker to it; zero or more than one household defaults to private ("Just me") and never guesses.
 */
export function HouseholdPicker(props: HouseholdPickerProps) {
  const { theme } = useAppTheme();
  const [households, setHouseholds] = useState<MyHousehold[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedDefault = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<MyHousehold[]>("/v1/households")
      .then((result) => {
        if (cancelled) return;
        setHouseholds(result);
        // Create-mode default: exactly one household → default to it. Guarded by `appliedDefault` so this
        // never re-fires and clobbers a value the user has since changed (e.g. a refetch after this effect
        // somehow reruns), and only applies when the caller hasn't already chosen something.
        if (props.mode === "create" && !appliedDefault.current && result.length === 1 && props.value === null) {
          appliedDefault.current = true;
          props.onChange(result[0]!.household.id);
        }
      })
      .catch(() => {
        // Best-effort — same as lists.tsx's own households fetch: a failure here just means the picker
        // stays hidden (households === null renders nothing below) rather than blocking the create form or
        // detail screen this is embedded in.
        if (!cancelled) setHouseholds([]);
      });
    return () => {
      cancelled = true;
    };
    // Intentionally fetch once on mount only — `props.onChange`/`props.value` identity changing on every
    // parent render must not re-trigger this fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!households || households.length === 0) return null;

  async function select(householdId: string | null) {
    if (householdId === props.value) return;
    if (props.mode === "create") {
      props.onChange(householdId);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await props.onSave(householdId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update sharing for this item.");
    } finally {
      setSaving(false);
    }
  }

  const chipStyle = (selected: boolean) => ({
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: selected ? theme.colors.brandDefault : theme.colors.bgSubtle,
  });
  const chipTextStyle = (selected: boolean) => ({ fontSize: 13, fontWeight: "600" as const, color: selected ? "#fff" : theme.colors.textSecondary });

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>{props.label ?? "Share with"}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Pressable accessibilityRole="button" onPress={() => select(null)} disabled={saving} style={chipStyle(props.value === null)}>
          <Text style={chipTextStyle(props.value === null)}>Just me</Text>
        </Pressable>
        {households.map((h) => (
          <Pressable
            accessibilityRole="button"
            key={h.household.id}
            onPress={() => select(h.household.id)}
            disabled={saving}
            style={chipStyle(props.value === h.household.id)}
          >
            <Text style={chipTextStyle(props.value === h.household.id)}>{h.household.name}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
    </View>
  );
}
