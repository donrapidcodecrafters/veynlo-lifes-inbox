import { Button } from "./button";

interface FetchErrorProps {
  /** Optional specifics from the real server error (ApiError.message) — shown alongside the generic
   * copy rather than instead of it, since a raw backend message alone can read as too technical/blaming. */
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
  /** Swap the noun in the default copy ("this timeline", "your inbox") — optional, falls back to generic. */
  what?: string;
}

/**
 * Shared "transient fetch failure" affordance — distinct from the app's global 401 handling
 * (api-client.ts already redirects to sign-in on a dead session) and distinct from a genuine empty
 * state (EmptyState). This is specifically for a 500/network/timeout on an otherwise-working session,
 * which previously rendered as an indistinguishable blank/empty screen with no way to recover short of
 * a full page reload. Always paired with a real retry action (SWR's `mutate()`, or re-running a
 * `useEffect` load function) rather than a dead-end message.
 */
export function FetchError({ message, onRetry, retrying, what }: FetchErrorProps) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-critical/30 bg-critical-subtle px-6 py-10 text-center"
    >
      <div className="space-y-1">
        <p className="text-[0.9375rem] font-medium text-critical-subtle-text">
          Something went wrong loading {what ?? "this"}.
        </p>
        {message && (
          <p className="mx-auto max-w-sm text-sm text-critical-subtle-text/80">{message}</p>
        )}
      </div>
      <Button size="sm" variant="secondary" onClick={onRetry} loading={retrying}>
        Retry
      </Button>
    </div>
  );
}
