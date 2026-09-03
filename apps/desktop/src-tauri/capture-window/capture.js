// Served from the same `veynlo-capture://localhost` origin as index.html (see lib.rs's
// register_uri_scheme_protocol) — an external file rather than an inline <script> tag so it's allowed
// under tauri.conf.json's CSP without needing 'unsafe-inline' on script-src (an external same-origin
// script is already covered by `default-src 'self'`; an inline one would need a nonce/hash Tauri only
// auto-computes for pages served through the real frontendDist/asset-protocol pipeline, not a custom
// protocol handler like this one).
//
// No bundler runs over this file — it's read as-is by capture_window::CAPTURE_JS via `include_str!` and
// served verbatim, so there's no `import` of `@tauri-apps/api` here. `withGlobalTauri: true`
// (tauri.conf.json) is Tauri's own documented mechanism for exactly this "plain script tag, no build
// step" case: it injects `window.__TAURI__` into every webview in the app.
const tauri = window.__TAURI__;

let mode = "text";
const tabText = document.getElementById("tab-text");
const tabUrl = document.getElementById("tab-url");
const textInput = document.getElementById("text-input");
const urlInput = document.getElementById("url-input");
const status = document.getElementById("status");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");

function setMode(next) {
  mode = next;
  tabText.setAttribute("aria-pressed", String(next === "text"));
  tabUrl.setAttribute("aria-pressed", String(next === "url"));
  textInput.style.display = next === "text" ? "block" : "none";
  urlInput.style.display = next === "url" ? "block" : "none";
  (next === "text" ? textInput : urlInput).focus();
}

tabText.addEventListener("click", () => setMode("text"));
tabUrl.addEventListener("click", () => setMode("url"));

function closeWindow() {
  tauri.core.invoke("close_quick_capture").catch(() => {
    // Best-effort — even if the invoke itself fails, don't trap the user in the popup.
    window.close();
  });
}

cancelBtn.addEventListener("click", closeWindow);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWindow();
  // Cmd/Ctrl+Enter submits from either field without leaving the keyboard.
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
});

// The window is hidden (not destroyed) on close so re-opening it via the hotkey/tray is instant — see
// close_quick_capture's own doc comment. Reset the form each time it becomes visible again so a previous
// capture's leftover text/status doesn't greet the next one.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  textInput.value = "";
  urlInput.value = "";
  status.textContent = "";
  status.className = "status";
  submitBtn.disabled = false;
  submitBtn.textContent = "Capture";
  setMode("text");
});

async function submit() {
  status.textContent = "";
  status.className = "status";

  const payload = mode === "url" ? { mode: "url", url: urlInput.value.trim() } : { mode: "text", bodyText: textInput.value.trim() };

  if (mode === "url" && !payload.url) {
    status.textContent = "Enter a URL first.";
    status.className = "status error";
    return;
  }
  if (mode === "text" && !payload.bodyText) {
    status.textContent = "Type something to capture first.";
    status.className = "status error";
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Capturing…";
  try {
    await tauri.core.invoke("quick_capture", payload);
    status.textContent = "Captured. Closing…";
    status.className = "status success";
    setTimeout(closeWindow, 700);
  } catch (err) {
    status.textContent = typeof err === "string" ? err : "Something went wrong.";
    status.className = "status error";
    submitBtn.disabled = false;
    submitBtn.textContent = "Capture";
  }
}

submitBtn.addEventListener("click", submit);
