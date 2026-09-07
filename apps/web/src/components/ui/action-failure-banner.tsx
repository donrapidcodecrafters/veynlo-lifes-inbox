"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api-client";

/**
 * The write-side counterpart to `FetchError`.
 *
 * `FetchError` gives a failed *load* a visible, recoverable surface. Failed *actions* had no equivalent:
 * 42 action handlers across the app `await api.post(...)` with no catch, so a 500, a timeout, or a dropped
 * connection threw an uncaught rejection into the console and the user saw absolutely nothing. Found by
 * pressing `/documents` "Open" with its request forced to 500 — no dialog, no new tab, no change on the
 * page. A button that does nothing on failure is indistinguishable from a dead button, and the user's only
 * signal that their click did not happen is that the row they acted on is still sitting there.
 *
 * Fixed here rather than in 42 places on purpose: a per-handler `try/catch` fixes the sites that exist
 * today and silently reintroduces the hole in the next handler anyone writes. This listens for the
 * rejection itself, so a handler cannot forget.
 *
 * Deliberately narrow about what it claims:
 * - Only `ApiError` is surfaced. Any other rejection is left alone to reach the console as it does today —
 *   a component bug is not an "action failed" message.
 * - 401 is skipped: `api-client` already redirects a dead session to /sign-in, and a banner racing that
 *   redirect would say "unauthorized" on top of a sign-in page.
 * - `preventDefault()` is called ONLY for the errors it actually shows, so everything it does not handle
 *   still reports itself normally.
 */
export function ActionFailureBanner() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    function onRejection(event: PromiseRejectionEvent) {
      const err = event.reason;
      if (!(err instanceof ApiError)) return;
      // The session-death path owns its own UX (a redirect); adding a banner to it just races the redirect.
      if (err.status === 401) return;
      event.preventDefault();
      setMessage(err.message || "That didn't go through. Please try again.");
    }
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);

  useEffect(() => {
    if (!message) return;
    // Long enough to read a sentence, short enough not to sit over the page. Dismissible either way.
    const t = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(t);
  }, [message]);

  if (!message) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role="alert"
        className="pointer-events-auto flex max-w-lg items-start gap-3 rounded-xl border border-critical/30 bg-critical-subtle px-4 py-3 shadow-lg"
      >
        <p className="text-sm text-critical-subtle-text">{message}</p>
        <button
          type="button"
          onClick={() => setMessage(null)}
          aria-label="Dismiss"
          className="-mr-1 shrink-0 rounded px-1 text-sm text-critical-subtle-text/70 hover:text-critical-subtle-text"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
