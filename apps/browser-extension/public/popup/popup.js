const DEFAULT_API_BASE = "http://localhost:4000";

const views = {
  loading: document.getElementById("loading-view"),
  signedOut: document.getElementById("signed-out-view"),
  signedIn: document.getElementById("signed-in-view"),
};

function showView(name) {
  for (const view of Object.values(views)) view.classList.add("hidden");
  views[name].classList.remove("hidden");
}

async function apiFetch(path, options = {}) {
  const { token, apiBase } = await chrome.storage.local.get(["token", "apiBase"]);
  const headers = {
    "content-type": "application/json",
    "x-veynlo-platform": "extension",
    ...(options.headers ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${apiBase || DEFAULT_API_BASE}${path}`, { ...options, headers });
}

async function init() {
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    showView("signedOut");
    return;
  }
  const response = await apiFetch("/v1/auth/me");
  if (!response.ok) {
    await chrome.storage.local.remove("token");
    showView("signedOut");
    return;
  }
  const user = await response.json();
  document.getElementById("account-email").textContent = user.email;
  showView("signedIn");
}

document.getElementById("sign-in-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errorEl = document.getElementById("sign-in-error");
  errorEl.classList.add("hidden");

  const response = await apiFetch("/v1/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    errorEl.textContent = response.status === 401 ? "Incorrect email or password." : "Sign-in failed. Try again.";
    errorEl.classList.remove("hidden");
    return;
  }

  const body = await response.json();
  if (!body.token) {
    errorEl.textContent = "Sign-in did not return a session token.";
    errorEl.classList.remove("hidden");
    return;
  }
  await chrome.storage.local.set({ token: body.token });
  await init();
});

document.getElementById("sign-out").addEventListener("click", async () => {
  await apiFetch("/v1/auth/sign-out", { method: "POST" }).catch(() => {});
  await chrome.storage.local.remove("token");
  showView("signedOut");
});

async function saveCurrentTab(mode) {
  const statusEl = document.getElementById("save-status");
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Saving…";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let bodyText = tab?.url ?? "";

  if (mode === "selection" && tab?.id) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() ?? "",
      });
      if (!result) {
        statusEl.textContent = "No text selected on this page.";
        return;
      }
      bodyText = result;
    } catch {
      statusEl.textContent = "Couldn't read the page selection.";
      return;
    }
  }

  const response = await chrome.runtime.sendMessage({
    type: "veynlo:capture",
    payload: { url: tab?.url ?? "", title: tab?.title ?? "", bodyText },
  });

  statusEl.textContent = response?.ok ? "Saved to your Veynlo inbox." : (response?.error ?? "Save failed.");
}

document.getElementById("save-page").addEventListener("click", () => saveCurrentTab("page"));
document.getElementById("save-selection").addEventListener("click", () => saveCurrentTab("selection"));

init();
