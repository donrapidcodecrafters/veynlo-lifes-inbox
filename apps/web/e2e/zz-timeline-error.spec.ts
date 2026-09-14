import { test } from "@playwright/test";

/**
 * Capture the actual exception behind /timeline's "Application error: a client-side exception has
 * occurred" screen.
 *
 * This is a genuine defect, not a harness artifact: the page throws during render, React unmounts the
 * whole tree including the (app) layout, and that is why the route reported zero <nav> elements and
 * zero interactive controls. On mobile it also means a user who reaches /timeline has no bottom nav and
 * no in-page way out — the exact "trapped with no way home" class of failure Don reported originally.
 *
 * A production build minifies the error, so this also loads the dev-mode message when available.
 */

test("capture /timeline client-side exception", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message}\n${(e.stack || "").split("\n").slice(0, 6).join("\n")}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`CONSOLE ${m.text()}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill("alex@example.com");
  await page.getByLabel("Password", { exact: true }).fill("Demo-Password-1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  await page.goto("/timeline");
  await page.waitForTimeout(3000);

  console.log(`\n===== /timeline diagnostics — ${errors.length} error(s) =====`);
  for (const e of errors) console.log(e + "\n");

  const body = await page.locator("body").innerText().catch(() => "");
  console.log(`body text: ${JSON.stringify(body.slice(0, 200))}`);

  // Compare against a route known to render, to prove the failure is specific to /timeline rather than
  // a broken session or a global layout fault.
  await page.goto("/lists");
  await page.waitForTimeout(1500);
  const ok = await page.locator("body").innerText().catch(() => "");
  console.log(`/lists renders: ${ok.slice(0, 60).replace(/\n/g, " ")}`);
});
