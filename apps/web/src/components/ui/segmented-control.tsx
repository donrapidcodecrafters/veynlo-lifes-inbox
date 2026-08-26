interface Option<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  "aria-label": string;
}

/** Small set of mutually-exclusive choices — a segmented control, not a radio list or dropdown. */
export function SegmentedControl<T extends string>({ value, onChange, options, ...rest }: SegmentedControlProps<T>) {
  return (
    <div role="radiogroup" aria-label={rest["aria-label"]} className="inline-flex gap-1 rounded-lg bg-subtle p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            value === opt.value ? "bg-surface text-primary shadow-xs" : "text-tertiary hover:text-secondary"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
