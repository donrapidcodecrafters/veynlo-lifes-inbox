import { createPlaidLinkSession, type LinkSuccess, type LinkExit } from "react-native-plaid-link-sdk";
import type { PlaidLinkResult } from "./plaid-link.types";

/**
 * Native (iOS/Android) implementation, backed by the real `react-native-plaid-link-sdk` — see
 * `plaid-link.web.ts` for why this file is split from that one rather than gated with a runtime
 * `Platform.OS` check inside a single module.
 *
 * Wraps the SDK's callback-based `createPlaidLinkSession`/`session.open()` API (v13 — the SDK dropped
 * the older `<PlaidLink>` component and `usePlaidEmitter` hook in this version; "Build your own button
 * and call createPlaidLinkSession" is now the documented pattern) in a single promise so the caller
 * doesn't need to juggle onSuccess/onExit/onEvent callbacks itself — same end result the web app's
 * PlaidConnectCard gets from its own onSuccess/onExit pair (apps/web/src/app/(app)/connections/page.tsx).
 */
export const plaidLinkAvailable = true;

export async function openPlaidLink(linkToken: string): Promise<PlaidLinkResult> {
  let settle: ((result: PlaidLinkResult) => void) | null = null;
  const resultPromise = new Promise<PlaidLinkResult>((resolve) => {
    settle = resolve;
  });

  try {
    const session = await createPlaidLinkSession({
      token: linkToken,
      onSuccess: (success: LinkSuccess) => settle?.({ status: "success", publicToken: success.publicToken }),
      onExit: (exit: LinkExit) => {
        // A user closing Link without finishing (the common case — tapped the back/close button) comes
        // through here with no `error`. An actual failure (bad credentials repeatedly, institution down,
        // etc.) sets `error`, which carries a `displayMessage` meant for end users when Plaid provides one.
        settle?.(exit.error ? { status: "error", message: exit.error.displayMessage ?? exit.error.errorMessage } : { status: "cancelled" });
      },
      // Required by LinkTokenConfiguration; this app has no use for Link's fine-grained step-by-step
      // telemetry, so this is intentionally a no-op rather than left undefined.
      onEvent: () => {},
    });
    await session.open();
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "Couldn't open the bank connection flow. Please try again." };
  }

  return resultPromise;
}
