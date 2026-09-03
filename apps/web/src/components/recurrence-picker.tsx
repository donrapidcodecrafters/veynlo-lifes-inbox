"use client";

import type { RecurrenceRule } from "@veynlo/core";
import { Input } from "@/components/ui/input";

// TASK-003 — every recurrence kind the backend can expand, minus "days_before" (needs picking *another*
// task/event as the anchor — a whole separate entity picker, not just a form field — and pure mileage-
// based recurrence, which is out of scope entirely: see packages/core/src/util/recurrence.ts's own doc
// comment on why). Spec's own guidance is "not every exotic option needs full glory in v1" — this covers
// daily/weekly/monthly/yearly/nth-weekday/business-day, which is everything a user can set through this
// picker for a plain (non-vehicle) task or event.
const KIND_OPTIONS: { value: RecurrenceRule["kind"] | "none"; label: string }[] = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "nth_weekday", label: "Monthly, on a specific weekday" },
  { value: "business_day", label: "Every N business days" },
];

// VEH-003 "mileage_or_calendar" — a distinct, opt-in extra kind (not folded into KIND_OPTIONS above)
// rendered only when the caller passes a non-empty `vehicles` list, i.e. only from the vehicle-maintenance-
// relevant task creation flow (AddTaskForm) — never from AddEventForm, which never passes that prop. Plain
// "mileage" (with no calendar side) stays entirely unexposed here, same as before: every real maintenance
// interval a user would actually set through this picker either has a calendar cadence alone, or a
// calendar-cadence-with-a-mileage-backstop, never mileage with no time backstop at all.
const MILEAGE_OR_CALENDAR_OPTION = { value: "mileage_or_calendar" as const, label: "Every N months or N miles (vehicle)" };

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NTH_OPTIONS: { value: -1 | 1 | 2 | 3 | 4; label: string }[] = [
  { value: 1, label: "1st" },
  { value: 2, label: "2nd" },
  { value: 3, label: "3rd" },
  { value: 4, label: "4th" },
  { value: -1, label: "Last" },
];

const selectClassName =
  "h-9 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary focus:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]";

/**
 * TASK-003 — the only place a user can actually set a recurrence rule (backend support existed, but
 * nothing in the UI could ever set `recurrenceRule`, which is the bug this whole feature closes). Shared
 * between AddTaskForm/AddEventForm's creation flow and the event detail page's "edit recurrence" control.
 *
 * `vehicles`, when passed with at least one entry, additionally offers the "mileage_or_calendar" composite
 * kind (VEH-003) — see MILEAGE_OR_CALENDAR_OPTION's own comment for why this is opt-in via a prop rather
 * than always shown.
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
        return; // not offered by this picker — see KIND_OPTIONS's own comment
    }
  }

  function setInterval(interval: number) {
    // "days_before"/"mileage"/"mileage_or_calendar" have no plain `interval` field — see KIND_OPTIONS's
    // own comment on why none of the three is offered as a bare "every N ___" row here.
    if (!value || value.kind === "days_before" || value.kind === "mileage" || value.kind === "mileage_or_calendar") return;
    onChange({ ...value, interval: Math.max(1, Math.min(365, interval || 1)) });
  }

  function toggleWeekday(day: number) {
    if (!value || value.kind !== "weekly") return;
    const set = new Set(value.daysOfWeek);
    if (set.has(day)) set.delete(day);
    else set.add(day);
    onChange({ ...value, daysOfWeek: [...set].sort() });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Repeats" value={kind} onChange={(e) => setKind(e.target.value as RecurrenceRule["kind"] | "none")} className={selectClassName}>
        {kindOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {value && value.kind !== "days_before" && value.kind !== "mileage" && value.kind !== "mileage_or_calendar" && (
        <div className="flex items-center gap-1.5 text-sm text-tertiary">
          <span>every</span>
          <div className="w-16">
            <Input
              type="number"
              min={1}
              max={365}
              value={value.interval}
              onChange={(e) => setInterval(Number(e.target.value))}
              aria-label="Repeat interval"
            />
          </div>
          <span>
            {value.kind === "daily" && "day(s)"}
            {value.kind === "weekly" && "week(s)"}
            {(value.kind === "monthly" || value.kind === "nth_weekday") && "month(s)"}
            {value.kind === "yearly" && "year(s)"}
            {value.kind === "business_day" && "business day(s)"}
          </span>
        </div>
      )}

      {value?.kind === "weekly" && (
        <div className="flex flex-wrap gap-1">
          {WEEKDAY_LABELS.map((label, day) => {
            const active = value.daysOfWeek.includes(day);
            return (
              <button
                key={day}
                type="button"
                onClick={() => toggleWeekday(day)}
                aria-pressed={active}
                className={`h-8 w-10 rounded-md text-xs font-medium ${active ? "bg-brand text-on-brand" : "bg-subtle text-tertiary hover:text-secondary"}`}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {value?.kind === "monthly" && (
        <div className="flex items-center gap-1.5 text-sm text-tertiary">
          <span>on day</span>
          <div className="w-16">
            <Input
              type="number"
              min={1}
              max={31}
              placeholder="—"
              value={value.dayOfMonth ?? ""}
              onChange={(e) => onChange({ ...value, dayOfMonth: e.target.value ? Number(e.target.value) : null })}
              aria-label="Day of month"
            />
          </div>
          <span className="text-xs">(blank = same day each month)</span>
        </div>
      )}

      {value?.kind === "nth_weekday" && (
        <div className="flex items-center gap-1.5 text-sm text-tertiary">
          <select
            aria-label="Which occurrence"
            value={value.nth}
            onChange={(e) => onChange({ ...value, nth: Number(e.target.value) as -1 | 1 | 2 | 3 | 4 })}
            className={selectClassName}
          >
            {NTH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Which weekday"
            value={value.weekday}
            onChange={(e) => onChange({ ...value, weekday: Number(e.target.value) })}
            className={selectClassName}
          >
            {WEEKDAY_LABELS.map((label, day) => (
              <option key={day} value={day}>
                {label}
              </option>
            ))}
          </select>
        </div>
      )}

      {value?.kind === "mileage_or_calendar" && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-tertiary">
          <span>every</span>
          <div className="w-16">
            <Input
              type="number"
              min={1}
              max={120}
              value={value.intervalMonths}
              onChange={(e) => onChange({ ...value, intervalMonths: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })}
              aria-label="Repeat interval (months)"
            />
          </div>
          <span>month(s) or</span>
          <div className="w-20">
            <Input
              type="number"
              min={1}
              max={200_000}
              value={value.intervalMiles}
              onChange={(e) => onChange({ ...value, intervalMiles: Math.max(1, Math.min(200_000, Number(e.target.value) || 1)) })}
              aria-label="Repeat interval (miles)"
            />
          </div>
          <span>mile(s), whichever comes first, for</span>
          <select
            aria-label="Vehicle"
            value={value.vehicleProfileId}
            onChange={(e) => onChange({ ...value, vehicleProfileId: e.target.value })}
            className={selectClassName}
          >
            {vehicles?.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
