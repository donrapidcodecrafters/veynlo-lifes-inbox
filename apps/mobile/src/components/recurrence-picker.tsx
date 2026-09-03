import { Pressable, Text, View } from "react-native";
import type { RecurrenceRule } from "@veynlo/core";
import { useAppTheme } from "@/lib/theme-context";
import { TextField } from "@/components/text-field";
import { Card } from "@/components/card";

// TASK-003 — same scope as apps/web's RecurrencePicker (see its own comment): every kind the backend can
// expand except "days_before" (needs a separate entity picker) and plain mileage-based (out of scope
// entirely).
const KIND_OPTIONS: { value: RecurrenceRule["kind"] | "none"; label: string }[] = [
  { value: "none", label: "Never" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "nth_weekday", label: "Nth weekday" },
  { value: "business_day", label: "Business day" },
];

// VEH-003 — mirrors apps/web's identical MILEAGE_OR_CALENDAR_OPTION; see its own comment on why this is
// opt-in via a `vehicles` prop rather than always offered.
const MILEAGE_OR_CALENDAR_OPTION = { value: "mileage_or_calendar" as const, label: "Months or miles" };

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NTH_OPTIONS: { value: -1 | 1 | 2 | 3 | 4; label: string }[] = [
  { value: 1, label: "1st" },
  { value: 2, label: "2nd" },
  { value: 3, label: "3rd" },
  { value: 4, label: "4th" },
  { value: -1, label: "Last" },
];

function Pill({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const { theme } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 999,
        backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
      }}
    >
      <Text
        style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textOnBrand : theme.colors.textSecondary }}
        maxFontSizeMultiplier={1.6}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * TASK-003 — mobile counterpart to apps/web's RecurrencePicker; see its doc comment for the overall scope
 * decision. `vehicles`, when passed with at least one entry, additionally offers the "mileage_or_calendar"
 * composite kind (VEH-003) — mirrors apps/web's identical prop.
 */
export function RecurrencePicker({
  value,
  onChange,
  vehicles,
}: {
  value: RecurrenceRule | null;
  onChange: (rule: RecurrenceRule | null) => void;
  vehicles?: { id: string; label: string }[];
}) {
  const { theme } = useAppTheme();
  const kind = value?.kind ?? "none";
  const kindOptions = vehicles && vehicles.length > 0 ? [...KIND_OPTIONS, MILEAGE_OR_CALENDAR_OPTION] : KIND_OPTIONS;

  function setKind(next: RecurrenceRule["kind"] | "none") {
    if (next === "none") {
      onChange(null);
      return;
    }
    switch (next) {
      case "daily":
      case "yearly":
        onChange({ kind: next, interval: 1 });
        return;
      case "weekly":
        onChange({ kind: "weekly", interval: 1, daysOfWeek: [] });
        return;
      case "monthly":
        onChange({ kind: "monthly", interval: 1, dayOfMonth: null });
        return;
      case "nth_weekday":
        onChange({ kind: "nth_weekday", interval: 1, weekday: 1, nth: 1 });
        return;
      case "business_day":
        onChange({ kind: "business_day", interval: 1 });
        return;
      case "mileage_or_calendar":
        onChange({ kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 3000, vehicleProfileId: vehicles?.[0]?.id ?? "", baselineMileage: null });
        return;
      case "days_before":
      case "mileage":
        return; // neither is offered by this picker — see KIND_OPTIONS's own comment
    }
  }

  function toggleWeekday(day: number) {
    if (!value || value.kind !== "weekly") return;
    const set = new Set(value.daysOfWeek);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    onChange({ ...value, daysOfWeek: [...set].sort() });
  }

  return (
    <View style={{ gap: 10 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Repeats</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {kindOptions.map((opt) => (
          <Pill key={opt.value} label={opt.label} active={kind === opt.value} onPress={() => setKind(opt.value)} />
        ))}
      </View>

      {value && value.kind !== "days_before" && value.kind !== "mileage" && value.kind !== "mileage_or_calendar" && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Every</Text>
          <View style={{ width: 70 }}>
            <TextField
              label=""
              accessibilityLabel="Repeat interval"
              value={String(value.interval)}
              onChangeText={(t) => onChange({ ...value, interval: Math.max(1, Math.min(365, Number(t) || 1)) })}
              keyboardType="number-pad"
            />
          </View>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            {value.kind === "daily" && "day(s)"}
            {value.kind === "weekly" && "week(s)"}
            {(value.kind === "monthly" || value.kind === "nth_weekday") && "month(s)"}
            {value.kind === "yearly" && "year(s)"}
            {value.kind === "business_day" && "business day(s)"}
          </Text>
        </View>
      )}

      {value?.kind === "weekly" && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {WEEKDAY_LABELS.map((label, day) => (
            <Pill key={day} label={label} active={value.daysOfWeek.includes(day)} onPress={() => toggleWeekday(day)} />
          ))}
        </View>
      )}

      {value?.kind === "monthly" && (
        <Card style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>On day</Text>
          <View style={{ width: 70 }}>
            <TextField
              label=""
              accessibilityLabel="Day of month"
              placeholder="—"
              value={value.dayOfMonth != null ? String(value.dayOfMonth) : ""}
              onChangeText={(t) => onChange({ ...value, dayOfMonth: t ? Number(t) : null })}
              keyboardType="number-pad"
            />
          </View>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, flexShrink: 1 }}>Blank = same day each month</Text>
        </Card>
      )}

      {value?.kind === "nth_weekday" && (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {NTH_OPTIONS.map((opt) => (
              <Pill key={opt.value} label={opt.label} active={value.nth === opt.value} onPress={() => onChange({ ...value, nth: opt.value })} />
            ))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {WEEKDAY_LABELS.map((label, day) => (
              <Pill key={day} label={label} active={value.weekday === day} onPress={() => onChange({ ...value, weekday: day })} />
            ))}
          </View>
        </View>
      )}

      {value?.kind === "mileage_or_calendar" && (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Every</Text>
            <View style={{ width: 60 }}>
              <TextField
                label=""
                accessibilityLabel="Interval in months"
                value={String(value.intervalMonths)}
                onChangeText={(t) => onChange({ ...value, intervalMonths: Math.max(1, Math.min(120, Number(t) || 1)) })}
                keyboardType="number-pad"
              />
            </View>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>mo. or</Text>
            <View style={{ width: 70 }}>
              <TextField
                label=""
                accessibilityLabel="Interval in miles"
                value={String(value.intervalMiles)}
                onChangeText={(t) => onChange({ ...value, intervalMiles: Math.max(1, Math.min(200_000, Number(t) || 1)) })}
                keyboardType="number-pad"
              />
            </View>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>mi., first</Text>
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {vehicles?.map((v) => (
              <Pill key={v.id} label={v.label} active={value.vehicleProfileId === v.id} onPress={() => onChange({ ...value, vehicleProfileId: v.id })} />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
