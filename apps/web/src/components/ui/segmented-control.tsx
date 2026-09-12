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
          // Every segment draws a border, selected or not. An unselected segment used to be bare text on
          // the track, which is the one thing a user cannot tell apart from a label — and the track alone
          // does not say "these words are three separate choices". The unselected border is deliberately
          // faint so the selected segment still wins the eye.
          className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
            value === opt.value
              ? "border-border-default bg-surface text-primary shadow-xs"
              : "border-border-subtle text-tertiary hover:text-secondary"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
