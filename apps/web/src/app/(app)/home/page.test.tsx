import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { axe } from "jest-axe";
import { SWRConfig } from "swr";
import HomePage from "./page";

// SWR's cache is a module-level singleton by default — without a fresh provider per test, the second
// test's render would synchronously paint the FIRST test's cached "/v1/home" response (real bug this
// caught: SWR's own dedupingInterval then suppresses revalidation long enough that `waitFor` below timed
// out still showing test one's data).
function renderIsolated(ui: ReactElement) {
  return render(<SWRConfig value={{ provider: () => new Map() }}>{ui}</SWRConfig>);
}

/**
 * §54.2 launch criterion 11 ("accessibility critical journeys pass automated review") — extends the
 * shared-component axe coverage (components/ui/accessibility.test.tsx) to a real assembled page: Home is
 * the very first screen every user lands on. Mocks the network boundary only (global fetch) so the real
 * component tree — SWR data flow, conditional empty/loaded states, real Badge/Button/DropdownMenu usage —
 * renders and gets scanned exactly as a browser would produce it, not a hand-assembled fixture.
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

describe("Home page — automated accessibility", () => {
  it("the loaded 'Needs You' journey (attention items, urgency badges, actions) has no violations", async () => {
    mockFetchJson({
      "/v1/home/today": { items: [{ kind: "event", id: "evt_1", title: "Dentist appointment", at: new Date().toISOString() }] },
      "/v1/home": {
        caughtUp: false,
        degraded: true,
        unhealthyConnections: [{ id: "conn_1", provider: "gmail", health: "reauth_required" }],
        items: [
          {
            id: "att_1",
            reasonText: "Your electric bill is due soon",
            urgency: "critical",
            dueAt: { date: new Date().toISOString().slice(0, 10) },
            moneyAtStakeMinorUnits: 12345,
            moneyAtStakeCurrency: "USD",
            primaryActions: ["resolve"],
            assignedToUserId: null,
            linkedResourceType: "bill",
            linkedResourceId: "bill_1",
          },
        ],
      },
      "/v1/households": [],
    });

    const { container } = renderIsolated(<HomePage />);
    await waitFor(() => expect(within(container).getByText("Your electric bill is due soon")).toBeInTheDocument());

    expect(await axe(container)).toHaveNoViolations();
  });

  it("the caught-up empty state has no violations", async () => {
    mockFetchJson({
      "/v1/home/today": { items: [] },
      "/v1/home": { caughtUp: true, degraded: false, unhealthyConnections: [], items: [] },
      "/v1/households": [],
    });

    const { container } = renderIsolated(<HomePage />);
    await waitFor(() => expect(within(container).getByText("You're caught up.")).toBeInTheDocument());

    expect(await axe(container)).toHaveNoViolations();
  });
});
