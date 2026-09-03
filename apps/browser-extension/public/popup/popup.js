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
    // Fastify's default JSON body parser rejects ANY request that declares
    // `content-type: application/json` with an empty body — "Body cannot be empty when content-type is
    // set to 'application/json'" (FST_ERR_CTP_EMPTY_JSON_BODY) — before the request ever reaches a
    // controller or the auth guard. Every bodyless call through this helper (sign-out is the one that
    // matters most) used to send this header unconditionally, so `POST /v1/auth/sign-out` 400'd server-side
    // on every real sign-out. `.catch(() => {})` around that call swallowed the failure (fetch() only
    // rejects on network errors, never on a 4xx/5xx response), so the popup still cleared its local token
    // and showed "signed out" — but the session itself was never revoked and kept working against the API
    // indefinitely (confirmed live via this audit: the pre-sign-out bearer token still returned 200 from
    // `/v1/auth/me` afterward). apps/web/src/lib/api-client.ts already guards this exact way for the same
    // reason — mirror it here instead of hardcoding the header.
    ...(options.body ? { "content-type": "application/json" } : {}),
    "x-veynlo-platform": "extension",
    ...(options.headers ?? {}),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${apiBase || DEFAULT_API_BASE}${path}`, { ...options, headers });
}

/**
 * §37.1 "Quick list — Choose destination list/private/household. Extension gets only list metadata
 * needed for picker." `/v1/lists` already returns just id/name/kind/householdId/itemCounts — no item
 * contents — so this reuses it directly rather than adding a separate lighter-weight endpoint.
 */
async function loadQuickListOptions() {
  const select = document.getElementById("quick-list-select");
  select.innerHTML = "";
  try {
    const response = await apiFetch("/v1/lists");
    if (!response.ok) return;
    const lists = await response.json();
    if (lists.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No lists yet — create one in Veynlo";
      select.appendChild(option);
      document.getElementById("add-to-list").disabled = true;
      return;
    }
    document.getElementById("add-to-list").disabled = false;
    for (const list of lists) {
      const option = document.createElement("option");
      option.value = list.id;
      option.textContent = list.householdId ? `${list.name} (shared)` : list.name;
      // The popup is a fixed 300px panel — a native <select> truncates long list names with no ellipsis
      // and no way to see the rest (found live via this audit with a long test list name). `title` gives a
      // hover tooltip with the full name so users aren't guessing which list they're about to add to.
      option.title = option.textContent;
      select.appendChild(option);
    }
  } catch {
    // Not worth surfacing as an error — Save page/Save selection remain fully usable either way.
  }
}

async function init() {
  const { token } = await chrome.storage.local.get("token");
  if (!token) {
    showView("signedOut");
    return;
  }
  try {
    const response = await apiFetch("/v1/auth/me");
    if (!response.ok) {
      await chrome.storage.local.remove("token");
      showView("signedOut");
      return;
    }
    const user = await response.json();
    document.getElementById("account-email").textContent = user.email;
    showView("signedIn");
    await loadQuickListOptions();
  } catch {
    // A network failure (server unreachable, or an invalid API base URL saved on the options page —
    // `new URL()` inside fetch() throws synchronously for a non-URL string) used to leave the popup
    // stuck on the "Loading…" view forever with no error and no way to recover short of visiting the
    // options page blind (found live via this audit). The token is left in storage — this might be a
    // transient outage, not an invalid session — so a retry (reopening the popup) can still succeed.
    showView("signedOut");
    const errorEl = document.getElementById("sign-in-error");
    errorEl.textContent = "Couldn't reach Veynlo. Check your connection or the API endpoint in Settings.";
    errorEl.classList.remove("hidden");
  }
}

document.getElementById("sign-in-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const errorEl = document.getElementById("sign-in-error");
  errorEl.classList.add("hidden");

  let response;
  try {
    response = await apiFetch("/v1/auth/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  } catch {
    // apiFetch's fetch() call had no try/catch here at all — a network failure (server down, or a bad
    // API base URL from the options page) threw and became an unhandled promise rejection in this
    // "submit" listener: no error text, no re-enabled anything, the user just watched nothing happen
    // (confirmed live via this audit by aborting the sign-in request and checking for a DOM/console
    // signal — there was none).
    errorEl.textContent = "Couldn't reach Veynlo. Check your connection or the API endpoint in Settings.";
    errorEl.classList.remove("hidden");
    return;
  }

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

/**
 * §37.1 "Product capture"/"Event/place capture" — injected into the page via chrome.scripting, so it must
 * be a fully self-contained function (no closures over anything outside itself; the same constraint the
 * existing selection-capture injection already has). Reads Open Graph meta tags and JSON-LD structured
 * data (Product/Event/Offer — the schema.org types most retail/event pages already publish for link
 * previews and SEO), falling back to plain visible text when a page has neither.
 */
function scrapePageMetadata() {
  const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content ?? null;
  const parts = [];
  const ogTitle = meta("og:title");
  const ogDescription = meta("og:description");
  const ogType = meta("og:type");
  const price = meta("product:price:amount") ?? meta("og:price:amount");
  const currency = meta("product:price:currency") ?? meta("og:price:currency");
  const siteName = meta("og:site_name");
  if (ogTitle) parts.push(`Title: ${ogTitle}`);
  if (siteName) parts.push(`Site: ${siteName}`);
  if (ogType) parts.push(`Type: ${ogType}`);
  if (price) parts.push(`Price: ${price}${currency ? ` ${currency}` : ""}`);
  if (ogDescription) parts.push(`Description: ${ogDescription}`);

  const ldBlocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 5);
  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block.textContent || "");
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const type = item?.["@type"];
        if (type === "Product" || type === "Event" || type === "Offer") {
          parts.push(`Structured data (${type}): ${JSON.stringify(item).slice(0, 1500)}`);
        }
      }
    } catch {
      // Malformed JSON-LD is common in the wild (hand-edited templates, truncated scripts) — skip it
      // rather than letting one bad block abort the whole scrape.
    }
  }

  if (parts.length === 0) {
    parts.push((document.body?.innerText || "").slice(0, 3000));
  }
  return parts.join("\n");
}

async function saveCurrentTab(mode) {
  const statusEl = document.getElementById("save-status");
  const savePageButton = document.getElementById("save-page");
  const saveSelectionButton = document.getElementById("save-selection");
  // Neither button is disabled while a save is in flight (found live via this audit's double-click repro:
  // two clicks on "Save this page" fired two concurrent identical requests). Disabling both — not just the
  // one clicked — prevents a second click from starting a second request with different content (e.g.
  // clicking "Save selected text" mid-page-save) while one is already outstanding.
  savePageButton.disabled = true;
  saveSelectionButton.disabled = true;
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Saving…";

  try {
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
    } else if (mode === "page" && tab?.id) {
      // §37.1 "Product capture"/"Event/place capture" — a bare URL gives Veynlo's ingestion pipeline
      // (the same domain classifier/extractors every connected-email capture already goes through)
      // almost nothing to work with. Open Graph/JSON-LD metadata is exactly what most product and event
      // pages already publish for link-preview purposes, so scraping it here needs no new backend code.
      try {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePageMetadata });
        if (result) bodyText = result;
      } catch {
        // Falls back to the bare URL already assigned above — some pages (chrome://, restricted origins)
        // can't be scripted at all, and that's fine, not worth surfacing as an error to the user.
      }
    }

    const response = await chrome.runtime.sendMessage({
      type: "veynlo:capture",
      payload: { url: tab?.url ?? "", title: tab?.title ?? "", bodyText },
    });

    statusEl.textContent = response?.ok ? "Saved to your Veynlo inbox." : (response?.error ?? "Save failed.");
  } finally {
    savePageButton.disabled = false;
    saveSelectionButton.disabled = false;
  }
}

document.getElementById("save-page").addEventListener("click", () => saveCurrentTab("page"));
document.getElementById("save-selection").addEventListener("click", () => saveCurrentTab("selection"));

/**
 * §29.1 SAVE-001 "Save anything... page/link" — distinct from saveCurrentTab above (which files an Inbox
 * item via the email-style ingestion pipeline, `/v1/ingestion/manual`). This posts directly to the Saved
 * Memory system (`POST /v1/memories`): private by default, classified into a category in the background,
 * findable and resurfaced from the web/mobile Saved tab. Reuses the same scrapePageMetadata page-script
 * saveCurrentTab already injects for its "page" mode, and the same SAVE_TO_LIST double-click guard pattern.
 */
document.getElementById("save-to-saved").addEventListener("click", async () => {
  const statusEl = document.getElementById("save-to-saved-status");
  const button = document.getElementById("save-to-saved");
  button.disabled = true;
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Saving…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let rawText = tab?.url ?? "";
    if (tab?.id) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePageMetadata });
        if (result) rawText = result;
      } catch {
        // Falls back to the bare URL — some pages (chrome://, restricted origins) can't be scripted at all.
      }
    }

    const response = await apiFetch("/v1/memories", {
      method: "POST",
      body: JSON.stringify({ sourceKind: "link", sourceUrl: tab?.url ?? undefined, rawText, title: tab?.title || undefined }),
    });
    if (response.ok) {
      const body = await response.json();
      statusEl.textContent = body.duplicate ? "Already in your Saved items." : "Saved.";
    } else {
      statusEl.textContent = "Couldn't save that page.";
    }
  } catch {
    // apiFetch() had no catch here — a network failure (server unreachable, bad API base URL) threw,
    // was never caught, and left statusEl stuck reading "Saving…" forever even though `finally` below
    // re-enabled the button — a silent failure indistinguishable from a hang (confirmed live via this
    // audit by aborting the /v1/memories request).
    statusEl.textContent = "Couldn't save that page. Check your connection.";
  } finally {
    button.disabled = false;
  }
});

document.getElementById("add-to-list").addEventListener("click", async () => {
  const statusEl = document.getElementById("quick-list-status");
  const listId = document.getElementById("quick-list-select").value;
  if (!listId) return;
  const addButton = document.getElementById("add-to-list");
  // POST /v1/lists/:id/items has no idempotency guard (unlike /v1/ingestion/manual — see popup save-page's
  // own doc comment), so a double-click here silently creates two identical saved_items rows rather than
  // erroring — same fix as the save buttons, applied consistently.
  addButton.disabled = true;
  statusEl.classList.remove("hidden");
  statusEl.textContent = "Adding…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let label = tab?.title || tab?.url || "Untitled page";
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() ?? "",
      });
      if (result) label = result.slice(0, 300);
    } catch {
      // No selection or an unscriptable page (chrome://, etc.) — fall back to the page title, same as above.
    }

    const response = await apiFetch(`/v1/lists/${listId}/items`, {
      method: "POST",
      body: JSON.stringify({ label }),
    });
    statusEl.textContent = response.ok ? "Added to your list." : "Couldn't add that item.";
  } catch {
    // Same missing-catch bug as "Save to Saved" above — a network failure left this stuck reading
    // "Adding…" forever with the button silently re-enabled by `finally`, no error ever shown.
    statusEl.textContent = "Couldn't add that item. Check your connection.";
  } finally {
    addButton.disabled = false;
  }
});

init();
