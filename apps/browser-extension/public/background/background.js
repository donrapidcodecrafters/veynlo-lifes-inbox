const DEFAULT_API_BASE = "http://localhost:4000";
const CONTEXT_MENU_PAGE = "veynlo-save-page";
const CONTEXT_MENU_SELECTION = "veynlo-save-selection";

chrome.runtime.onInstalled.addListener(() => {
  // onInstalled fires on every extension update/reload, not just the first install (confirmed live via this
  // audit: reloading an already-installed copy from chrome://extensions re-runs this listener on a profile
  // that already has both menu items). Without clearing first, chrome.contextMenus.create silently fails
  // with "Cannot create item with duplicate id" via chrome.runtime.lastError — never thrown, never checked
  // below, so this broke on every update/reload with no visible symptom beyond a service-worker console error.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PAGE,
      title: "Save page to Veynlo",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_SELECTION,
      title: "Save selection to Veynlo",
      contexts: ["selection"],
    });
  });
});

/** Duplicated from popup.js's identical function — see its own doc comment. Content-script injection
 * functions must be self-contained (chrome.scripting serializes `func` with no closure support), so
 * this extension's two independent capture surfaces (popup, context menu) each carry their own copy
 * rather than sharing a module neither currently imports. */
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
      // Malformed JSON-LD is common in the wild — skip it rather than aborting the whole scrape.
    }
  }

  if (parts.length === 0) {
    parts.push((document.body?.innerText || "").slice(0, 3000));
  }
  return parts.join("\n");
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === CONTEXT_MENU_PAGE) {
    let bodyText = tab.url ?? "";
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePageMetadata });
      if (result) bodyText = result;
    } catch {
      // Falls back to the bare URL — some pages can't be scripted at all (chrome://, restricted origins).
    }
    await captureAndSave({ url: tab.url ?? "", title: tab.title ?? "", bodyText });
  } else if (info.menuItemId === CONTEXT_MENU_SELECTION && info.selectionText) {
    await captureAndSave({ url: tab.url ?? "", title: tab.title ?? "", bodyText: info.selectionText });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "veynlo:capture") {
    captureAndSave(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
    return true;
  }
  return false;
});

async function captureAndSave({ url, title, bodyText }) {
  const { token, apiBase } = await chrome.storage.local.get(["token", "apiBase"]);
  if (!token) {
    throw new Error("Not signed in to Veynlo.");
  }

  // With no active tab there is no title and no URL, so both fields would be empty and the request could
  // only ever come back 400. Refuse locally, with wording a person can act on, rather than showing them a
  // validation error for a request they did not know they were making.
  const subject = title || url;
  const composedBody = [title, url, bodyText].filter(Boolean).join("\n\n");
  if (!subject || !composedBody) {
    throw new Error("Open a page in a tab first, then try saving it.");
  }

  const response = await fetch(`${apiBase || DEFAULT_API_BASE}/v1/ingestion/manual`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-veynlo-platform": "extension",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      subject,
      bodyText: composedBody,
    }),
  });

  if (!response.ok) {
    // Surface the API's own human-readable `message`, the way apps/web and apps/mobile already do. This
    // used to interpolate the raw response body, so a validation failure showed the user the whole JSON
    // envelope — code, fieldErrors and traceId included — inside a 320px popup. Found live during the
    // audit: `Save failed (400): {"code":"VALIDATION_FAILED","message":"Request body failed validation.",
    // "fieldErrors":{...},"retryable":false,"traceId":"c4fa064d-..."}`.
    const text = await response.text().catch(() => "");
    let message = "";
    try {
      message = JSON.parse(text)?.message ?? "";
    } catch {
      // Not JSON — a proxy error page, or an empty body. Fall through to the generic wording below.
    }
    throw new Error(message || `Couldn't save that (${response.status}). Please try again.`);
  }

  const body = await response.json();
  await showBadge("✓");
  return body;
}

async function showBadge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: "#5B63E3" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
}
