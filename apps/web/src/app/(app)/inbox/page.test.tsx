import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import InboxPage from "./page";

/**
 * §54.2 launch criterion 11 ("accessibility critical journeys pass automated review") — Inbox is the
 * other screen every user works from daily (review/confirm/correct/dismiss discovered items). Same
 * approach as home/page.test.tsx: mock only the network boundary, render the real page, scan the real
 * assembled DOM.
 */
function mockFetchJson(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const match = Object.entries(routes).find(([path]) => url.includes(path));
      const body = match ? match[1] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Inbox page — automated accessibility", () => {
  it("the loaded review journey (confidence badges, confirm/correct/dropdown actions) has no violations", async () => {
    mockFetchJson({
      "/v1/inbox": {
        items: [
          {
            id: "inbox_1",
            category: "bill",
            summary: "Electric bill — $123.45 due Sept 15",
            confidenceBand: "needs_review",
            reviewState: "new",
            autoFiled: false,
            suggestedActions: ["confirm"],
            linkedResourceType: "bill",
          },
          {
            id: "inbox_2",
            category: "purchase",
            summary: "Amazon order — $42.10",
            confidenceBand: "conflicting",
            reviewState: "new",
            autoFiled: false,
            suggestedActions: ["confirm"],
            linkedResourceType: "purchase",
          },
        ],
        nextCursor: null,
      },
    });

    const { container } = render(<InboxPage />);
    await waitFor(() => expect(within(container).getByText(/Electric bill/)).toBeInTheDocument());

    expect(await axe(container)).toHaveNoViolations();
  });

  it("the caught-up empty state has no violations", async () => {
    mockFetchJson({ "/v1/inbox": { items: [], nextCursor: null } });

    const { container } = render(<InboxPage />);
    await waitFor(() => expect(within(container).getByText("You're caught up.")).toBeInTheDocument());

    expect(await axe(container)).toHaveNoViolations();
  });
});
