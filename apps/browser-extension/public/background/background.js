const DEFAULT_API_BASE = "http://localhost:4000";
const CONTEXT_MENU_PAGE = "veynlo-save-page";
const CONTEXT_MENU_SELECTION = "veynlo-save-selection";

chrome.runtime.onInstalled.addListener(() => {
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

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === CONTEXT_MENU_PAGE) {
    await captureAndSave({ url: tab.url ?? "", title: tab.title ?? "", bodyText: tab.url ?? "" });
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

  const response = await fetch(`${apiBase || DEFAULT_API_BASE}/v1/ingestion/manual`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-veynlo-platform": "extension",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      subject: title || url,
      bodyText: [title, url, bodyText].filter(Boolean).join("\n\n"),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Save failed (${response.status}): ${text}`);
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
