import { test } from "@playwright/test";

/**
 * Resolves the last two NO_CHANGE controls from the sweep to real verdicts.
 *
 * "Add a passkey" — a WebAuthn registration cannot complete in a plain browser context because there is
 * no authenticator to respond, so a plain click legitimately produces nothing observable. That is a
 * limitation of the harness, not evidence about the button. Chrome DevTools Protocol can install a
 * VIRTUAL authenticator, which makes the real flow completable and turns "no change" into an actual
 * pass/fail. Anything less would be assuming the button works because it looks like it should.
 *
 * "Make owner" — expected to require a target member to be chosen first. The question is whether it is
 * inert or merely conditional, and whether the UI explains which.
 */

const DEMO_EMAIL = "alex@example.com";
const DEMO_PASSWORD = "Demo-Password-1";

test("Add a passkey — with a virtual authenticator attached", async ({ page, context }) => {
  test.setTimeout(3 * 60 * 1000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`PAGEERROR ${e.message.slice(0, 140)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`CONSOLE ${m.text().slice(0, 140)}`);
  });

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  console.log(`virtual authenticator attached: ${authenticatorId}`);

  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  await page.goto("/settings/security");
  await page.waitForTimeout(1500);

  const before = await page.locator("main").innerText();
  await page.getByRole("button", { name: /add a passkey/i }).first().click();
  await page.waitForTimeout(5000);
  const after = await page.locator("main").innerText();

  const credentials = await cdp.send("WebAuthn.getCredentials", { authenticatorId }).catch(() => ({ credentials: [] as unknown[] }));
  console.log(`credentials registered on the authenticator: ${credentials.credentials.length}`);
  console.log(`page content changed: ${before !== after ? "YES" : "NO"}`);
  if (before !== after) {
    console.log("new text: " + JSON.stringify(after.split("\n").filter((l) => !before.includes(l)).slice(0, 4)));
  }
  if (errors.length) console.log("errors: " + errors.slice(0, 3).join(" | "));
  console.log(
    credentials.credentials.length > 0
      ? "VERDICT: WORKS — a real credential was created"
      : "VERDICT: did not register a credential — needs investigation",
  );
});

test("Make owner — inert, or conditional on selecting a member?", async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEMO_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in"), { timeout: 30_000 });

  await page.goto("/settings/household");
  await page.waitForTimeout(1500);

  const state = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button")).filter((b) => /make owner/i.test(b.textContent || ""));
    return btns.map((b) => ({
      disabled: (b as HTMLButtonElement).disabled,
      ariaDisabled: b.getAttribute("aria-disabled"),
      title: b.getAttribute("title"),
      // What sits beside it matters: a control that is conditional should say so.
      row: (b.closest("li,tr,div")?.textContent || "").trim().slice(0, 120),
    }));
  });
  console.log("Make owner buttons: " + JSON.stringify(state, null, 1));

  const reqs: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/v1/") && r.method() !== "GET") reqs.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  const before = await page.locator("main").innerText();
  await page.getByRole("button", { name: /make owner/i }).first().click().catch(() => {});
  await page.waitForTimeout(2500);
  const after = await page.locator("main").innerText();
  console.log(`network: ${reqs.join(", ") || "(none)"}`);
  console.log(`content changed: ${before !== after ? "YES" : "NO"}`);
  if (before !== after) console.log("new: " + JSON.stringify(after.split("\n").filter((l) => !before.includes(l)).slice(0, 4)));
});
