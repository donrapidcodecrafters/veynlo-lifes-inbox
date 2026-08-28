export interface TemporalValueLike {
  precision: "instant" | "date" | "month" | "approximate" | "unknown";
  instantUtc: string | null;
  date: string | null;
  timezone: string | null;
  sourceText: string | null;
}

export function formatTemporal(value: TemporalValueLike | null | undefined): string | null {
  if (!value) return null;
  if (value.precision === "instant" && value.instantUtc) {
    return new Date(value.instantUtc).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  if (value.precision === "date" && value.date) {
    return new Date(`${value.date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  if (value.precision === "approximate" && value.sourceText) return value.sourceText;
  return null;
}

export function formatMoneyMinorUnits(minorUnits: number | null | undefined, currency: string | null | undefined): string | null {
  if (minorUnits == null || !currency) return null;
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minorUnits / 100);
}

export function daysUntil(value: TemporalValueLike | null | undefined): number | null {
  if (!value) return null;
  const target = value.instantUtc ?? (value.date ? `${value.date}T00:00:00` : null);
  if (!target) return null;
  const diffMs = new Date(target).getTime() - Date.now();
  return Math.ceil(diffMs / 86_400_000);
}
