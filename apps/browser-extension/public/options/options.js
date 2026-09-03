const DEFAULT_API_BASE = "http://localhost:4000";

async function init() {
  const { token, apiBase } = await chrome.storage.local.get(["token", "apiBase"]);
  document.getElementById("api-base").value = apiBase || DEFAULT_API_BASE;

  const statusEl = document.getElementById("account-status");
  const signOutButton = document.getElementById("sign-out");

  if (!token) {
    statusEl.textContent = "Not signed in. Use the Veynlo toolbar icon to sign in.";
    signOutButton.classList.add("hidden");
    return;
  }

  const response = await fetch(`${apiBase || DEFAULT_API_BASE}/v1/auth/me`, {
    headers: { "x-veynlo-platform": "extension", authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    statusEl.textContent = "Session expired. Sign in again from the toolbar icon.";
    await chrome.storage.local.remove("token");
    signOutButton.classList.add("hidden");
    return;
  }

  const user = await response.json();
  statusEl.textContent = `Signed in as ${user.email}.`;
  signOutButton.classList.remove("hidden");
}

document.getElementById("sign-out").addEventListener("click", async () => {
  const { token, apiBase } = await chrome.storage.local.get(["token", "apiBase"]);
  if (token) {
    await fetch(`${apiBase || DEFAULT_API_BASE}/v1/auth/sign-out`, {
      method: "POST",
      headers: { "x-veynlo-platform": "extension", authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  await chrome.storage.local.remove("token");
  init();
});

document.getElementById("save-api-base").addEventListener("click", async () => {
  const statusEl = document.getElementById("save-status");
  const apiBaseInput = document.getElementById("api-base");
  const value = apiBaseInput.value.trim() || DEFAULT_API_BASE;

  // No validation existed at all — saving e.g. "not a url" persisted it verbatim to chrome.storage, and
  // the popup's every fetch() call then throws synchronously on that malformed URL. Before this fix that
  // left the popup permanently stuck on its "Loading…" view with zero feedback (see popup.js's init()
  // fix, same audit finding). Rejecting bad input here, at the source, is the first line of defense.
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    statusEl.textContent = "Enter a valid URL, e.g. http://localhost:4000.";
    statusEl.classList.remove("hidden");
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    statusEl.textContent = "The API base URL must start with http:// or https://.";
    statusEl.classList.remove("hidden");
    return;
  }

  await chrome.storage.local.set({ apiBase: value });
  // The input previously kept showing whatever the user typed (including an empty/whitespace-only value
  // that silently falls back to DEFAULT_API_BASE above) even though a different value was actually
  // persisted — "Saved." would show next to a field that no longer matched what was stored, until the
  // next popup/options reload (confirmed live via this audit). Reflect the resolved value immediately.
  apiBaseInput.value = value;
  statusEl.textContent = "Saved.";
  statusEl.classList.remove("hidden");
  setTimeout(() => statusEl.classList.add("hidden"), 2000);
});

init();
