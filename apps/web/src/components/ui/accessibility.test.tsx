import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "jest-axe";
import { Button } from "./button";
import { Input, Label, FieldError } from "./input";
import { Switch } from "./switch";
import { SegmentedControl } from "./segmented-control";
import { Badge } from "./badge";

/**
 * §54.2 launch acceptance criterion 11 ("accessibility critical journeys pass manual and automated
 * review") — no automated accessibility tooling existed anywhere in this repo before this. Rather than
 * mocking Next.js routing/data-fetching to render whole pages, these test the shared UI primitives every
 * page is built from directly — a real axe-core scan of the actual rendered DOM, not a lint-rule guess.
 * Catching a violation here protects every page that uses the component, not just one screen.
 */
describe("shared UI components — automated accessibility", () => {
  it("Button has no violations across every variant", async () => {
    const { container } = render(
      <div>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="critical">Critical</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Loading</Button>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("a Label + Input pair with a matching id/htmlFor has no violations", async () => {
    const { container } = render(
      <div>
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" />
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("an Input in an invalid state with a FieldError has no violations", async () => {
    const { container } = render(
      <div>
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" error="Too short" />
        <FieldError>Too short</FieldError>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Switch, used correctly with an id, has no violations", async () => {
    const { container } = render(
      <Switch id="daily-brief" label="Daily brief" description="A short summary each morning." checked onCheckedChange={() => {}} />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Switch WITHOUT an explicit id still has no violations (a real bug this test caught and fixed)", async () => {
    // This test caught a genuine bug on first write: Switch's `id` prop was optional with no fallback, so
    // omitting it left the visible <label> with no `for` and the switch <button> with no `id` — nothing
    // associated them, and since the button has no text content of its own (only an `aria-hidden` thumb),
    // it had NO accessible name at all (a real axe-core `button-name` violation, not a hypothetical one).
    // Fixed in switch.tsx with `useId()` as a fallback; this test now guards against that regressing.
    const { container } = render(<Switch label="Unlabeled switch" checked={false} onCheckedChange={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("SegmentedControl's radiogroup pattern has no violations", async () => {
    const { container } = render(
      <SegmentedControl
        aria-label="Theme"
        value="system"
        onChange={() => {}}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Badge has no violations across every tone", async () => {
    const { container } = render(
      <div>
        <Badge>Neutral</Badge>
        <Badge tone="positive">Positive</Badge>
        <Badge tone="warning">Warning</Badge>
        <Badge tone="critical">Critical</Badge>
      </div>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
