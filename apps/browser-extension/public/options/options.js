const DEFAULT_API_BASE = "http://localhost:4000";

async function init() {
  const { token, apiBase } = await chrome.storage.local.get(["token", "apiBase"]);
  document.getElementById("api-base").value = apiBase || DEFAULT_API_BASE;

  const statusEl = document.getElementById("account-status");
  const signOutButton = document.getElementById("sign-out");

  if (!token) {
    statusEl.textContent = "Not signed in. Use the Veynlo toolbar icon to sign in.";
    return;
  }

  const response = await fetch(`${apiBase || DEFAULT_API_BASE}/v1/auth/me`, {
    headers: { "x-veynlo-platform": "extension", authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    statusEl.textContent = "Session expired. Sign in again from the toolbar icon.";
    await chrome.storage.local.remove("token");
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
  const value = document.getElementById("api-base").value.trim() || DEFAULT_API_BASE;
  await chrome.storage.local.set({ apiBase: value });
  const statusEl = document.getElementById("save-status");
  statusEl.textContent = "Saved.";
  statusEl.classList.remove("hidden");
  setTimeout(() => statusEl.classList.add("hidden"), 2000);
});

init();
