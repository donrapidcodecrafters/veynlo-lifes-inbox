import { test } from "@playwright/test";

/**
 * Turns the R1 sweep's NO_CHANGE results into actual verdicts.
 *
 * NO_CHANGE is not a defect on its own — a control can legitimately do nothing (an already-selected tab,
 * a radio that is already the active choice). But it is also exactly where a real dead control hides, so
 * every one has to be resolved individually rather than written off in a batch.
 *
 * It is also where MY OWN harness hides. R1 detects change via `aria-checked` or a diff of <main>'s text.
 * A native <input type="checkbox"> exposes state on the `.checked` PROPERTY, not `aria-checked`, and
 * ticking one may not alter any visible text — so a perfectly working checkbox reports NO_CHANGE. This
 * reads the real property before and after, which distinguishes "control is dead" from "my detector was
 * looking at the wrong attribute".
 */

const DEMO_EMAIL = "alex@example.com";
const DEMO_PASSWORD = "Demo-Password-1";

const CASES: Array<{ route: string; label: string }> = [
  { route: "/settings/sharing/caregiver-passes", label: "Access instructions" },
  { route: "/settings/sharing/caregiver-passes", label: "Household contacts" },
  { route: "/settings/sharing/caregiver-passes", label: "Schedule" },
  { route: "/settings/sharing/caregiver-passes", label: "Pet care" },
  { route: "/settings/sharing/caregiver-passes", label: "Kids" },
  { route: "/settings/personalization", label: "Save" },
  { route: "/settings/household", label: "Make owner" },
  { route: "/settings/security", label: "Add a passkey" },
];

test("resolve NO_CHANGE controls to real verdicts", async ({ page }) => {
  test.setTimeout(5 * 60 * 1000);

  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 120));
  });
  page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR ${e.message.slice(0, 120)}`));

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  for (const c of CASES) {
    await page.goto(c.route);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(900);

    const before = consoleErrors.length;
    const el = page.getByText(c.label, { exact: true }).first();
    if ((await el.count()) === 0) {
      console.log(`${c.route} "${c.label}" -> NOT FOUND on page`);
      continue;
    }

    // Read every state channel, not just aria-checked.
    const readState = async () =>
      page.evaluate((label) => {
        const all = Array.from(document.querySelectorAll<HTMLElement>("*"));
        const node = all.find((e) => e.children.length === 0 && (e.textContent || "").trim() === label);
        if (!node) return null;
        const box =
          node.closest("label")?.querySelector<HTMLInputElement>('input[type="checkbox"],input[type="radio"]') ??
          (node.previousElementSibling as HTMLInputElement | null) ??
          document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
        const btn = node.closest("button,[role=switch],[role=checkbox],[role=radio]");
        return {
          inputChecked: box ? box.checked : null,
          ariaChecked: btn ? btn.getAttribute("aria-checked") : null,
          ariaPressed: btn ? btn.getAttribute("aria-pressed") : null,
          mainLen: (document.querySelector("main")?.innerText || "").length,
          url: location.pathname,
        };
      }, c.label);

    const s0 = await readState();
    await el.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(700);
    const s1 = await readState();

    const newErrors = consoleErrors.slice(before);
    const changedInput = s0 && s1 && s0.inputChecked !== s1.inputChecked;
    const changedAria = s0 && s1 && (s0.ariaChecked !== s1.ariaChecked || s0.ariaPressed !== s1.ariaPressed);
    const changedText = s0 && s1 && s0.mainLen !== s1.mainLen;
    const navigated = s0 && s1 && s0.url !== s1.url;

    const verdict = changedInput
      ? "WORKS (input.checked flipped — R1 missed it: only read aria-checked)"
      : changedAria
        ? "WORKS (aria state changed)"
        : navigated
          ? `WORKS (navigated to ${s1?.url})`
          : changedText
            ? "WORKS (page content changed)"
            : "STILL NO CHANGE — needs a human look";

    console.log(
      `${c.route} "${c.label}"\n   before=${JSON.stringify(s0)}\n   after =${JSON.stringify(s1)}\n   => ${verdict}${newErrors.length ? ` | errors: ${newErrors.join("; ")}` : ""}`,
    );
  }
});
