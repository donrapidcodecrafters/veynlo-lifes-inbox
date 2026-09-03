use std::collections::HashSet;
use std::time::Duration;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::WebviewWindowBuilder,
    AppHandle, DragDropEvent, Manager, WebviewUrl, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

/// Hosts allowed to load *or navigate to* inside the desktop webview — every other origin (a link inside
/// a rendered email/document, a malicious redirect) is blocked rather than followed. §28.7 "restrict
/// desktop webview navigation to Veynlo-controlled origins; block arbitrary new-window/navigation
/// behavior unless explicitly handled." `auth.veynlo.com` is included for the eventual Cognito/OIDC
/// hosted sign-in flow (blueprint Appendix A); it does the app no good to load without it.
const ALLOWED_HOSTS: [&str; 4] = ["localhost", "app.veynlo.com", "api.veynlo.com", "auth.veynlo.com"];

const MAIN_WINDOW_LABEL: &str = "main";
const QUICK_CAPTURE_WINDOW_LABEL: &str = "quick-capture";
const QUICK_CAPTURE_SHORTCUT: &str = "CmdOrCtrl+Shift+I";

/// The custom URI scheme the quick-capture window is served from — see `CAPTURE_HTML`'s doc comment for
/// why this exists instead of a plain `file://` URL.
const CAPTURE_SCHEME: &str = "veynlo-capture";

/// The quick-capture window's entire HTML/CSS/JS, embedded into the binary at compile time (not the
/// Next.js web app — a tiny, separate page, `capture-window/index.html`). Served over a registered custom
/// URI scheme (`register_uri_scheme_protocol` in `run()` below) rather than a plain `file://` URL — a real
/// bug found live while testing this: a `file://` page's IPC calls carry a literal `Origin: null` header,
/// and Tauri's own IPC protocol handler (`tauri::ipc::protocol`) rejects that with "Origin header is not a
/// valid URL" before `invoke()` ever reaches this crate's command handlers, so a `file://` quick-capture
/// window could never actually submit anything. A custom-protocol page gets a real, parseable origin
/// instead (`veynlo-capture://localhost` — see `register_uri_scheme_protocol`'s own doc comment on
/// tauri-2.11.5's `App`), which is also identical in `tauri dev` and a real `tauri build` — unlike
/// `WebviewUrl::App`, which would resolve relative to `devUrl` (`http://localhost:3000`) in a dev build,
/// where this page doesn't exist.
const CAPTURE_HTML: &str = include_str!("../capture-window/index.html");
/// The quick-capture page's JS, split into its own file (not an inline `<script>`) purely so
/// `tauri.conf.json`'s CSP allows it without `'unsafe-inline'` on `script-src` — a same-origin external
/// script is already covered by `default-src 'self'`. See capture.js's own doc comment.
const CAPTURE_JS: &str = include_str!("../capture-window/capture.js");

/// The exact httpOnly cookie name `services/api/src/modules/identity/identity.controller.ts` sets
/// (`SESSION_COOKIE`) and `auth.guard.ts` reads (`request.cookies?.veynlo_session`). The native bridge
/// (quick-capture, file-drop upload, the notification poller) reuses this real session rather than
/// inventing a separate desktop credential — see `session_cookie_header`'s own doc comment for why this
/// is read from the *webview's* cookie jar instead of a Tauri-side store.
const SESSION_COOKIE_NAME: &str = "veynlo_session";

/// Extensions this build will actually accept from a file drop or a file-association launch —
/// deliberately the same "document/image types" DSK-003 names, not an open-ended "any file" acceptance.
const ALLOWED_DROP_EXTENSIONS: [&str; 8] = ["pdf", "png", "jpg", "jpeg", "heic", "doc", "docx", "txt"];

fn is_allowed_navigation(url: &tauri::Url) -> bool {
    url.host_str().is_some_and(|host| ALLOWED_HOSTS.contains(&host))
}

/// Debug builds (`tauri dev`) point at the local web dev server; release builds point at the real
/// deployed web app. See `docs/PHASE2_PENDING_CREDENTIALS.md` — `https://app.veynlo.com` doesn't exist
/// yet (no AWS account), so this is a documented placeholder, not a live claim.
fn web_base_url() -> &'static str {
    if cfg!(debug_assertions) { "http://localhost:3000" } else { "https://app.veynlo.com" }
}

/// Same debug/release split as `web_base_url`, but for the API origin the native bridge (quick-capture,
/// file-drop upload, the notification poller) talks to directly over HTTP — see the module doc comment on
/// why this is a plain `reqwest` client rather than a webview `fetch()`.
fn api_base_url() -> &'static str {
    if cfg!(debug_assertions) { "http://localhost:4000" } else { "https://api.veynlo.com" }
}

/// Reads the real session cookie straight out of the **main window's** webview cookie jar (`WebviewWindow
/// ::cookies_for_url`, a real Tauri/wry API — not a JS `document.cookie` read, which would fail anyway
/// since the cookie is httpOnly). This is the same session a signed-in user already has in the main
/// window; the native bridge below (quick-capture's `#[tauri::command]`, the file-drop uploader, the
/// notification poller) forwards it as a plain `Cookie:` header on a native `reqwest` call.
///
/// Two things this deliberately avoids:
/// - A webview `fetch()` from the quick-capture window or an injected script would be subject to the
///   API's real CORS allowlist (`services/api/src/main.ts`'s `app.enableCors`, which only lists the web/
///   admin origins, not a `file://`/`tauri://` window) and would be rejected by the browser engine before
///   ever reaching the server. A native HTTP client isn't a browser and isn't subject to CORS at all —
///   exactly the same reasoning `auth.guard.ts`'s own doc comment gives for why native/bearer requests
///   skip CSRF (a browser can't be tricked into forging this transport; here we're not a browser at all).
/// - Inventing a separate desktop-only auth token would duplicate `AuthGuard`'s session model for no
///   reason — reusing the exact cookie the user already has means signing out in the web app also signs
///   the desktop bridge out, with zero extra code.
fn session_cookie_header(app: &AppHandle) -> Result<String, String> {
    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "Open Veynlo's main window first.".to_string())?;
    let api_url: tauri::Url = api_base_url().parse().expect("api_base_url() must always be a valid URL");
    let cookies = main
        .cookies_for_url(api_url)
        .map_err(|err| format!("Couldn't read the current Veynlo session: {err}"))?;
    cookies
        .iter()
        .find(|cookie| cookie.name() == SESSION_COOKIE_NAME)
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
        .ok_or_else(|| "Sign in to Veynlo first, then try again.".to_string())
}

/// DSK-002 "menu-bar/tray/hotkey opens tiny capture window from any app" — shared by the tray's "Quick
/// Capture" menu item and the global hotkey handler below. Reuses an already-open capture window (just
/// re-shows/focuses it) rather than stacking duplicate windows on repeated triggers.
fn show_quick_capture_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let url: tauri::Url = format!("{CAPTURE_SCHEME}://localhost/index.html")
        .parse()
        .expect("CAPTURE_SCHEME must produce a valid URL");

    if let Err(err) = WebviewWindowBuilder::new(app, QUICK_CAPTURE_WINDOW_LABEL, WebviewUrl::External(url))
        .title("Veynlo quick capture")
        .inner_size(420.0, 300.0)
        .min_inner_size(420.0, 300.0)
        .resizable(false)
        .always_on_top(true)
        .center()
        .skip_taskbar(true)
        .build()
    {
        eprintln!("failed to open the quick-capture window: {err}");
    }
}

fn guess_mime_type(extension: &str) -> &'static str {
    match extension {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "heic" => "image/heic",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// DSK-003 "file associations... Optional Open/Send to Life Inbox for supported document/image types" +
/// DSK-002's "file drop" — both a file dropped onto the main window and a file opened via the OS file
/// association (`tauri.conf.json`'s `bundle.fileAssociations`, handled via `RunEvent::Opened` in `run()`
/// below) end up here, reusing the exact same `POST /v1/documents/upload` path the web app's Documents
/// page drag-and-drop already uses (`apps/web/src/app/(app)/documents/page.tsx`) — same field names, same
/// field ORDER (title, documentType, then file last — see that page's own comment on why
/// @fastify/multipart requires the file part last).
async fn upload_document(app: &AppHandle, path: std::path::PathBuf) -> Result<String, String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document")
        .to_string();
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = guess_mime_type(&extension);

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("Couldn't read {filename}: {err}"))?;
    let cookie = session_cookie_header(app)?;

    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename.clone())
        .mime_str(mime)
        .map_err(|err| err.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("title", filename.clone())
        // No confident type-specific guess to make from a bare dropped file (unlike the web upload
        // form, which lets the user pick) — "other" is a real, accepted value in
        // `documents.controller.ts`'s VALID_DOCUMENT_TYPES, not a placeholder that silently fails.
        .text("documentType", "other")
        .part("file", file_part);

    let response = reqwest::Client::new()
        .post(format!("{}/v1/documents/upload", api_base_url()))
        .header(reqwest::header::COOKIE, cookie)
        .header("x-veynlo-csrf", "1")
        .header("x-veynlo-platform", "desktop")
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Veynlo: {err}"))?;

    if !response.status().is_success() {
        return Err(format!("{filename}: upload failed ({})", response.status()));
    }
    Ok(filename)
}

/// Fires once per drop/open batch (never once per file) so a multi-file drop produces one notification,
/// not a flood. Silently does nothing when nothing in the batch matched `ALLOWED_DROP_EXTENSIONS` (e.g. a
/// dropped folder, or an app/executable) rather than notifying about zero files.
fn handle_incoming_files(app: AppHandle, paths: Vec<std::path::PathBuf>) {
    tauri::async_runtime::spawn(async move {
        let mut succeeded = 0usize;
        let mut failed: Vec<String> = Vec::new();

        for path in paths {
            let allowed = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ALLOWED_DROP_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
                .unwrap_or(false);
            if !allowed {
                continue;
            }
            match upload_document(&app, path).await {
                Ok(_) => succeeded += 1,
                Err(err) => failed.push(err),
            }
        }

        if succeeded == 0 && failed.is_empty() {
            return;
        }
        let body = if failed.is_empty() {
            format!("{succeeded} file{} added to your Veynlo documents.", if succeeded == 1 { "" } else { "s" })
        } else if succeeded == 0 {
            format!("{} file(s) failed to upload — {}", failed.len(), failed.join("; "))
        } else {
            format!("{succeeded} added, {} failed.", failed.len())
        };
        let _ = app.notification().builder().title("Veynlo").body(body).show();
    });
}

/// DSK-006 "Native notifications mirror policy engine, not independent rules" — this deliberately does
/// NOT invent a second notification-decision system. `services/api`'s real notification-delivery service
/// already decides what to send and records it in the `notifications` table (surfaced today only via
/// polling `GET /v1/notifications` on `apps/web`'s in-app history page — there is no web-push
/// subscription anywhere in this codebase to hook into instead). This loop polls that same real endpoint
/// and mirrors anything newly `"sent"` out as a real OS notification — a bridge onto the existing policy
/// engine's output, not a parallel rule engine of its own.
///
/// The first successful poll only records a baseline (every currently-`sent` id) and notifies nothing —
/// without this, every user would get a flood of native notifications for their entire notification
/// history the moment the desktop app first launches. Only IDs that appear as `"sent"` on a LATER poll,
/// after that baseline, ever trigger a real notification.
fn spawn_notification_poller(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        let mut seen_ids: Option<HashSet<String>> = None;

        loop {
            // Slower before the very first successful pass (give the main window time to load/sign in);
            // steady-state otherwise.
            let delay = if seen_ids.is_none() { Duration::from_secs(15) } else { Duration::from_secs(45) };
            tokio::time::sleep(delay).await;

            let cookie = match session_cookie_header(&app) {
                Ok(cookie) => cookie,
                Err(_) => continue, // not signed in yet (or the main window isn't open) — retry next tick
            };
            let response = match client
                .get(format!("{}/v1/notifications", api_base_url()))
                .header(reqwest::header::COOKIE, cookie)
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => response,
                _ => continue,
            };
            let Ok(records) = response.json::<Vec<NotificationRecord>>().await else {
                continue;
            };

            match &mut seen_ids {
                None => {
                    seen_ids = Some(records.iter().map(|record| record.id.clone()).collect());
                }
                Some(seen) => {
                    for record in &records {
                        if record.state == "sent" && !seen.contains(&record.id) {
                            let _ = app
                                .notification()
                                .builder()
                                .title(record.title.clone())
                                .body(record.body.clone())
                                .show();
                        }
                        seen.insert(record.id.clone());
                    }
                }
            }
        }
    });
}

/// Only the fields the poller above actually needs — matching `GET /v1/notifications`'s real response
/// shape (`apps/web/src/app/(app)/settings/notifications/page.tsx`'s own `NotificationRecord` interface
/// has the full shape; extra fields here are simply ignored by serde, not an exhaustive re-declaration).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationRecord {
    id: String,
    title: String,
    body: String,
    state: String,
}

/// DSK-002 "Text, URL, clipboard on explicit action, file drop; choose privacy/list" (the privacy/list
/// picker itself isn't built — see the desktop README's own honest accounting of what this pass covers)
/// — posts to the exact same manual-capture endpoints `apps/web`'s "Add manually" flow already uses
/// (`POST /v1/ingestion/manual` / `POST /v1/ingestion/url`, both real, pre-existing, unmodified routes —
/// see `services/api/src/modules/ingestion/ingestion.controller.ts`). A plain native HTTP call (see
/// `session_cookie_header`'s doc comment for why), not a webview `fetch()` from the capture window.
#[tauri::command]
async fn quick_capture(app: AppHandle, mode: String, body_text: Option<String>, url: Option<String>) -> Result<(), String> {
    let cookie = session_cookie_header(&app)?;

    let (path, json_body) = if mode == "url" {
        let url = url.filter(|u| !u.trim().is_empty()).ok_or("Enter a URL first.")?;
        ("/v1/ingestion/url", serde_json::json!({ "url": url }))
    } else {
        let text = body_text.filter(|t| !t.trim().is_empty()).ok_or("Type something to capture first.")?;
        // IngestManualDtoSchema requires a non-empty `subject` separate from `bodyText` — the capture
        // window has no separate subject field (it's a "paste anything" box, matching DSK-002's own
        // "Text... on explicit action" framing), so the first line becomes the subject, same convention
        // `IngestionService`'s other text-derived subjects already use elsewhere in this codebase.
        let first_line = text.lines().next().unwrap_or("").trim();
        let subject: String = if first_line.is_empty() { "Quick capture".to_string() } else { first_line.chars().take(500).collect() };
        ("/v1/ingestion/manual", serde_json::json!({ "subject": subject, "bodyText": text }))
    };

    let response = reqwest::Client::new()
        .post(format!("{}{path}", api_base_url()))
        .header(reqwest::header::COOKIE, cookie)
        // §28.7 CSRF mitigation (services/api/src/common/csrf.ts) — required on every state-changing
        // cookie-authenticated request; see that file's own doc comment for why a deliberate header like
        // this (something a cross-site `<form>` can't forge) is the actual defense.
        .header("x-veynlo-csrf", "1")
        .header("x-veynlo-platform", "desktop")
        .json(&json_body)
        .send()
        .await
        .map_err(|err| format!("Couldn't reach Veynlo: {err}"))?;

    if !response.status().is_success() {
        let message = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|body| body.get("message").and_then(|m| m.as_str()).map(str::to_string))
            .unwrap_or_else(|| "Capture failed. Please try again.".to_string());
        return Err(message);
    }
    Ok(())
}

/// Hides (not closes) the quick-capture window so re-opening it via the hotkey/tray is instant — see
/// `show_quick_capture_window`'s reuse-if-present branch.
#[tauri::command]
async fn close_quick_capture(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(QUICK_CAPTURE_WINDOW_LABEL) {
        window.hide().map_err(|err| err.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _shortcut, event| {
                // DSK-002 "hotkey capture" — fires on key-down only, not key-up, so holding the
                // combination doesn't stack repeat triggers.
                if event.state == ShortcutState::Pressed {
                    show_quick_capture_window(app);
                }
            })
            .build())
        .plugin(tauri_plugin_notification::init())
        // Serves `CAPTURE_HTML` at `veynlo-capture://localhost/index.html` — see that constant's own doc
        // comment for why the quick-capture window needs a real custom-protocol origin rather than
        // `file://` or `WebviewUrl::App`.
        .register_uri_scheme_protocol(CAPTURE_SCHEME, |_ctx, request| {
            let (body, content_type): (&[u8], &str) = match request.uri().path() {
                "/" | "/index.html" => (CAPTURE_HTML.as_bytes(), "text/html; charset=utf-8"),
                "/capture.js" => (CAPTURE_JS.as_bytes(), "text/javascript; charset=utf-8"),
                _ => (&[], "text/plain"),
            };
            let status = if body.is_empty() { tauri::http::StatusCode::NOT_FOUND } else { tauri::http::StatusCode::OK };
            tauri::http::Response::builder()
                .status(status)
                .header(tauri::http::header::CONTENT_TYPE, content_type)
                .body(body.to_vec())
                .expect("a static response can always be built")
        })
        .invoke_handler(tauri::generate_handler![quick_capture, close_quick_capture])
        .setup(|app| {
            // Debug builds (`tauri dev`) point at the local web dev server; release builds point at the
            // real deployed web app. This used to be a single hardcoded `http://localhost:3000` in
            // tauri.conf.json's declarative `app.windows[]` — meaning a real, distributed release build
            // would try to load a dev server that doesn't exist on the end user's machine and show a
            // blank window. There is no real production domain yet (no AWS account, see docs/DECISIONS.md),
            // so this compiles in the blueprint's documented target domain (Appendix A) as the placeholder
            // release default — update this the moment a real `app.veynlo.com` exists, and before shipping
            // any release build to a real user.
            let main_window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::External(web_base_url().parse().expect("VEYNLO_WEB_URL must be a valid URL")))
                .title("Veynlo")
                .inner_size(1280.0, 820.0)
                .min_inner_size(960.0, 600.0)
                // §28.7 — the window itself never loads anything outside ALLOWED_HOSTS, on first load or
                // on any later navigation a click/redirect inside the page might attempt.
                .on_navigation(|nav_url| is_allowed_navigation(nav_url))
                .build()
                .expect("failed to build the main window");

            // DSK-002 "file drop" — the OS-level drag/drop Tauri already intercepts at the window level
            // (`dragDropEnabled` defaults to true) rather than the webview's own HTML5 drag/drop, which
            // would never fire for this window anyway since it's never the file's actual origin document.
            // Reuses the exact same document-upload capture path as a plain drop onto the web app's
            // Documents page — see `upload_document`'s own doc comment.
            let drop_handle = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) = event {
                    handle_incoming_files(drop_handle.clone(), paths.clone());
                }
            });

            // DSK-002 "Menu-bar/tray/hotkey opens tiny capture window from any app."
            let open_item = MenuItemBuilder::with_id("open", "Open Veynlo").build(app)?;
            let capture_item = MenuItemBuilder::with_id("quick_capture", "Quick Capture…").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit Veynlo").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&open_item)
                .item(&capture_item)
                .separator()
                .item(&quit_item)
                .build()?;

            TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(true)
                .icon(app.default_window_icon().cloned().expect("bundle.icon must be configured in tauri.conf.json"))
                .tooltip("Veynlo")
                .on_menu_event(|app, event| match event.id().0.as_str() {
                    "open" => {
                        if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quick_capture" => show_quick_capture_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // DSK-002 "hotkey capture" — a real OS-wide global shortcut (works even when Veynlo isn't the
            // focused app), not just an in-page keyboard handler. Registration can legitimately fail (the
            // combination is already claimed by another app/the OS) — logged, not fatal, since the tray's
            // "Quick Capture" menu item above still works either way.
            if let Err(err) = app.global_shortcut().register(QUICK_CAPTURE_SHORTCUT) {
                eprintln!("couldn't register the {QUICK_CAPTURE_SHORTCUT} global shortcut: {err}");
            }

            // DSK-003 "file associations... Optional Open/Send to Life Inbox" — the Windows/Linux half of
            // a file-association launch: the OS starts a *fresh* process with the file path as a plain
            // CLI argument (Tauri doesn't intercept this itself, it's just `std::env::args()`). This only
            // covers a cold start, not "hand the file to an already-running instance" (that needs the
            // single-instance plugin, deliberately not added this pass — see the desktop README). macOS's
            // equivalent (which delivers even to an already-running app) is handled below via
            // `RunEvent::Opened`, the platform's own dedicated mechanism for it.
            let launched_with_files: Vec<std::path::PathBuf> = std::env::args()
                .skip(1)
                .map(std::path::PathBuf::from)
                .filter(|path| {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .map(|ext| ALLOWED_DROP_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
                        .unwrap_or(false)
                })
                .collect();
            if !launched_with_files.is_empty() {
                handle_incoming_files(app.handle().clone(), launched_with_files);
            }

            spawn_notification_poller(app.handle().clone());

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Veynlo desktop app")
        .run(|app, event| {
            // DSK-003 "file associations... Optional Open/Send to Life Inbox" — macOS delivers a
            // double-clicked/associated file (`tauri.conf.json`'s `bundle.fileAssociations`) as a
            // `file://` URL here, even to an already-running instance — not as a drag-drop event, and not
            // via argv (that's the Windows/Linux cold-start path above). Reuses the exact same upload path
            // as a plain drop onto the window (`handle_incoming_files`/`upload_document`). This is the one
            // piece of DSK-003 that's declared but genuinely unverifiable in this environment: it requires
            // a real, signed, OS-registered app bundle to test a real double-click launch against, not
            // just a `cargo build` binary — see the desktop README's own accounting. `RunEvent::Opened`
            // only exists on macOS/iOS/Android (tauri's own cfg-gating), hence the platform gate here.
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<std::path::PathBuf> = urls.into_iter().filter_map(|url| url.to_file_path().ok()).collect();
                if !paths.is_empty() {
                    handle_incoming_files(app.clone(), paths);
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            let _ = (app, event);
        });
}
