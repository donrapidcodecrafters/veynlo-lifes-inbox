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
    // flex-wrap — with 4+ options (e.g. a 6-choice history-depth picker), a single unwrapping row can be
    // wider than a narrow mobile viewport, forcing the whole page to overflow horizontally rather than
    // just this control. Wrapping onto more than one line here costs far less than that.
    <div role="radiogroup" aria-label={rest["aria-label"]} className="inline-flex flex-wrap gap-1 rounded-lg bg-subtle p-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={`shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            value === opt.value ? "bg-surface text-primary shadow-xs" : "text-tertiary hover:text-secondary"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
