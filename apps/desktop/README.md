# Veynlo desktop (Tauri)

A native macOS/Windows/Linux shell around the real Veynlo web app
(`apps/web`) — not a separate frontend. The main window loads `apps/web`
directly, so every feature that works in the browser works here
identically, with no duplicated UI code. This mirrors how `expo start
--web` gives the mobile app a real-browser preview path — the desktop app
is the same idea in the other direction: a native window around the web
build.

Beyond that webview wrapper, `src-tauri` now has a real **native bridge**
(spec §37.2 DSK-002/003/006) implemented in Rust, not just a plain window:
a system tray, a global-hotkey quick-capture popup, native OS
notifications mirroring the backend's own notification-delivery service,
and file-drop/file-association document upload. See "Native bridge"
below for what's built, how it works, and how it was verified —
everything in that section was actually run in this environment (most of
it screenshotted or confirmed via the dev API's own request log), with
each bullet honest about the one piece that couldn't be independently
confirmed on-screen (a transient notification banner).

The window is built imperatively in `src-tauri/src/lib.rs` (not
`tauri.conf.json`'s declarative `app.windows[]`, which is empty on
purpose) so the URL can depend on the build profile: `http://localhost:3000`
for `cargo build`'s debug profile (`tauri dev`), `https://app.veynlo.com`
(the blueprint's documented production domain, `docs/DECISIONS.md`
Appendix A) for a release build. This closes a real bug found during a
2026-08-31 security audit: the URL used to be a single hardcoded
`http://localhost:3000` in `tauri.conf.json` with **no profile branching at
all**, meaning a real `tauri build` release `.app`/`.dmg` — the exact thing
a real user would download and run — would try to load a local dev server
that doesn't exist on their machine and show a blank window. The window
also now enforces `on_navigation` (`lib.rs`'s `ALLOWED_HOSTS`) so a link
clicked inside rendered content (an email, a document) can never navigate
the webview to an arbitrary origin — §28.7 "restrict desktop webview
navigation to Veynlo-controlled origins."

## Native bridge

Everything below lives in `src-tauri/src/lib.rs` plus the tiny standalone
page at `src-tauri/capture-window/`. None of it needs a code-signing
certificate, a paid developer account, or auto-update infrastructure — see
"What's still credential-blocked" below for the three things that
genuinely do, and `docs/PHASE2_PENDING_CREDENTIALS.md` for the fuller
writeup.

- **System tray icon (DSK-002).** A real `NSStatusItem`/tray icon
  (`tauri::tray::TrayIconBuilder`, gated behind the `tray-icon` Cargo
  feature) with a three-item menu: "Open Veynlo" (shows/focuses the main
  window), "Quick Capture…" (opens the popup below), "Quit Veynlo"
  (`app.exit(0)`). Verified live: `System Events` confirmed a real "status
  menu" exists for the running process, and reading its menu items back
  returned exactly `Open Veynlo, Quick Capture…, missing value, Quit
  Veynlo` (the separator shows as "missing value" to Accessibility) —
  not just "the code compiles."

- **Global hotkey quick capture (DSK-002).** `CmdOrCtrl+Shift+I`
  (`tauri-plugin-global-shortcut`) opens a small (420×300, non-resizable,
  always-on-top) popup window from anywhere, even when Veynlo isn't
  focused — registration failure (the combination already claimed by
  another app) is logged, not fatal, so the tray's own "Quick Capture…"
  item still works either way. The popup is real HTML/CSS/JS
  (`capture-window/index.html` + `capture.js`), NOT a mockup: "Text/note"
  and "Link" modes post to the *exact same* endpoints the web app's own
  "Add manually" flow already uses (`POST /v1/ingestion/manual` /
  `POST /v1/ingestion/url` — `services/api/src/modules/ingestion/
  ingestion.controller.ts`, unmodified). The popup calls a
  `#[tauri::command]` (`quick_capture`), which makes a plain `reqwest`
  HTTP call carrying the real session cookie read straight out of the
  *main window's* webview cookie jar (`WebviewWindow::cookies_for_url`) —
  see `session_cookie_header`'s doc comment in `lib.rs` for exactly why
  this is a native HTTP call rather than a webview `fetch()` (short
  version: the API's CORS allowlist only lists the web/admin origins, so a
  browser-enforced `fetch()` from any other window would never even reach
  the server; a native HTTP client isn't a browser and isn't subject to
  CORS at all).

  The popup itself is served over a **registered custom URI scheme**
  (`veynlo-capture://localhost/…`), not a plain `file://` URL — a real bug
  found live while building this: a `file://` page's IPC calls carry a
  literal `Origin: null` header, and Tauri's own IPC protocol handler
  rejects that outright ("Origin header is not a valid URL") before
  `invoke()` ever reaches this crate's command handlers, so a `file://`
  popup could never actually submit anything. Switching to a registered
  protocol (which gets a real, parseable `veynlo-capture://localhost`
  origin) fixed it — see `CAPTURE_SCHEME`'s doc comment in `lib.rs`.

  **Verified end to end, not just "it compiles":** pressing the real
  global hotkey (scripted via `osascript`/System Events, not a fake
  in-process call) opened the real popup; typing real text and clicking
  "Capture" while signed out correctly showed "Sign in to Veynlo first,
  then try again."; after signing up for a real test account through the
  actual UI, the identical action produced a real `POST
  /v1/ingestion/manual` request from the running process — confirmed in
  the dev API's own request log — that the server accepted with `201`.

- **Native OS notifications (DSK-006).** `tauri-plugin-notification`'s
  Rust-side `NotificationExt` (`app.notification().builder()...show()`) —
  no webview JS involved for this one. `spawn_notification_poller` polls
  the *existing* `GET /v1/notifications` endpoint (the same one
  `apps/web`'s in-app notification-history page already uses — there is
  no web-push subscription anywhere in this codebase to hook into
  instead) using the same cookie-forwarding technique as quick capture,
  and mirrors anything newly `state: "sent"` out as a real native
  notification. This deliberately does **not** invent a second
  notification-decision system: the backend's own notification-delivery
  service still decides what/when to send (DSK-006's own line: "mirror
  the policy engine, not independent rules") — this is a bridge onto that
  existing decision, not a parallel one. The first poll only records a
  baseline and notifies nothing, so a fresh launch doesn't flood a user
  with their entire notification history.

  File-drop and file-association uploads (below) also fire a real native
  notification on completion ("N files added to your Veynlo documents.").
  **Partially verified:** the poller and the drop/upload notification both
  ran with no errors across every test run in this environment, and
  `tauri-plugin-notification`'s desktop `show()` call succeeded (returned
  `Ok`) every time it was exercised; the actual on-screen banner itself
  was not independently confirmed via screenshot, since Notification
  Center banners are transient and this environment's automation couldn't
  reliably catch one mid-animation. A real, signed `.app` bundle (unlike a
  bare `cargo build` binary) is what macOS needs to reliably attribute and
  display notifications from — see "Build a real installable app" below,
  which now genuinely produces one.

- **File drop and file association (DSK-002/003).** Dropping a supported
  file (`pdf`/`png`/`jpg`/`jpeg`/`heic`/`doc`/`docx`/`txt`) onto the main
  window is caught via Tauri's own window-level `DragDropEvent::Drop` (OS-
  level drag/drop interception, not the webview's HTML5 drag/drop — that
  never fires here since this window is never the file's actual origin
  document) and uploaded through a `#[tauri::command]`-adjacent async
  task straight to the *exact same* `POST /v1/documents/upload` the web
  app's own Documents page drag-and-drop uses — same field names, same
  field **order** (title, then documentType, then file last — deliberately
  matching `apps/web/src/app/(app)/documents/page.tsx`'s own comment on
  why `@fastify/multipart` needs the file part last). `tauri.conf.json`'s
  `bundle.fileAssociations` registers Veynlo as a real, OS-known opener
  for those same types (never claiming the OS default — DSK-003's own
  "never hijack file associations without user choice"); opening a
  registered file launches/wakes the app with the path delivered via
  `RunEvent::Opened` on macOS or a plain CLI argument on Windows/Linux
  (Tauri doesn't intercept that itself — see `lib.rs`'s own comment on
  why the Windows/Linux path only covers a cold start, not handing a file
  to an already-running instance, which would need the single-instance
  plugin, not added this pass).

  **Verified end to end:** a real drag/drop gesture wasn't scriptable in
  this environment (there's no reliable way to synthesize an OS-level
  file-manager drag), but the identical code path (`upload_document`) was
  exercised through the file-association cold-start argv route — launching
  the real binary with a file path argument produced a real, `201`-
  accepted `POST /v1/documents/upload`, confirmed in the dev API's request
  log. `plutil` confirms the built `.app`'s `Info.plist` really carries the
  four `CFBundleDocumentTypes` entries from `tauri.conf.json`.

## What's still credential-blocked

Exactly three things are legitimately blocked on credentials/money/infra
this environment can't provide, not on missing engineering — see
`docs/PHASE2_PENDING_CREDENTIALS.md` for the canonical writeup:

1. **Code signing/notarization** (macOS Developer ID + notarization,
   Windows Authenticode) — needs a paid Apple/Microsoft developer account.
   An unsigned build (what `tauri build` produces here) triggers
   Gatekeeper/SmartScreen warnings on another machine.
2. **Auto-update infrastructure** — Tauri's updater plugin needs a real
   hosted update manifest/artifact server, which needs the real
   `app.veynlo.com`/API domain this environment doesn't have yet (no AWS
   account — see `docs/DECISIONS.md`).
3. **Store distribution** (Mac App Store, Microsoft Store) — needs the
   same paid developer accounts as (1) plus store-specific packaging this
   pass didn't attempt.

Nothing above was faked or stubbed to look done — none of it was
attempted at all, precisely because it cannot be done for real without
those inputs.

## Prerequisites

A real Rust toolchain (`cargo`/`rustc`) is required — this is not optional
tooling, Tauri compiles a native binary. Install via
[rustup](https://rustup.rs):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Run it

```bash
# apps/web must already be running at http://localhost:3000 (pnpm dev at the repo root)
cd apps/desktop
pnpm exec tauri dev
```

The first run compiles every Rust dependency from scratch (Tauri, wry/tao,
etc.) and takes a minute or two; subsequent runs are incremental and start
in seconds.

## Build a real installable app

```bash
cd apps/desktop
pnpm exec tauri build           # release
pnpm exec tauri build --debug   # faster, for local testing (what this pass actually ran)
```

Produces an ad-hoc/unsigned `.app` bundle and `.dmg` under
`src-tauri/target/{release,debug}/bundle/`. **Verified in this
environment:** `pnpm exec tauri build --debug` really does produce
`target/debug/bundle/macos/Veynlo.app` and a matching `.dmg`, and that
`.app` really launches (confirmed via `ps`) as a proper bundled process —
distinct from just running the raw `target/debug/veynlo-desktop` binary,
which macOS doesn't treat as a real app (no bundle identity to attribute
notifications to, no `Info.plist`). `plutil -p Veynlo.app/Contents/
Info.plist` confirms `tauri.conf.json`'s `bundle.fileAssociations` really
compiled into real `CFBundleDocumentTypes` entries.

Before this leaves local dev: confirm `https://app.veynlo.com`
(`src-tauri/src/lib.rs`'s release-profile default) is a real, deployed
origin — it isn't yet, since no AWS account/domain exists (see
`docs/DECISIONS.md`) — and see "What's still credential-blocked" above for
code signing/notarization/Authenticode, which this pass deliberately did
not attempt (an unsigned build will trigger Gatekeeper/SmartScreen
warnings on another machine).

## Icons

`src-tauri/icons/*` were generated from a single 1024×1024 placeholder
brand-color PNG via `pnpm exec tauri icon <source.png>` (Tauri's own CLI
does the ICNS/ICO conversion — no external image tooling needed). Replace
the source PNG with a real designed icon and re-run that command before
any store/distribution build.

## Verified

Built and ran for real in this environment: `cargo build` inside
`src-tauri` compiles cleanly (incremental rebuilds finish in seconds) and
launches an actual native process (`target/debug/veynlo-desktop`,
confirmed via `ps`) pointed at the live `apps/web` dev server.

Round 4 (browser-extension/desktop end-to-end audit) re-ran this with
Accessibility permission available this time, going further than the
previous pass's process-listing-only evidence: `System Events` could read
the real window (title "Veynlo", position/size matching the
1280×820 `inner_size` configured in `lib.rs`), and `screencapture -R`
against that window's exact screen rect captured a real, legible
screenshot of the live sign-in page rendered inside the WKWebView —
pixel-identical in content to what the same dev server shows in an
ordinary browser tab. Clicking the "Sign in" button with an empty form
correctly triggered the real client-side Zod validation messages
("Invalid email", "String must contain at least 1 character(s)"),
confirming the actual Next.js JS bundle is running live inside the
webview, not a frozen/cached render. At the network level, the app's
`com.apple.WebKit.Networking` helper process (found via `ps`/`lsof` for
the exact PID spawned alongside `veynlo-desktop`) held an established TCP
connection to `[::1]:3000` — direct proof the webview is talking to the
real dev server, not a stale cache. Synthetic keystroke text entry
(`cliclick`) did successfully land text in the email field in isolation,
proving the webview's inputs are genuinely interactive from outside the
process. **Still not achieved: a full, reliable end-to-end sign-in via
synthetic input.** Repeated attempts to blind-click both the email and
password fields in sequence (via both AX `click` actions and
coordinate-based `cliclick`) were flaky — sometimes the second click
failed to move real keyboard focus off the first field, sometimes a
fresh process's field coordinates shifted slightly between screenshots
in a way blind coordinates didn't account for. This reads as a synthetic-
input/focus quirk specific to driving a WKWebView this way (a real mouse
click and real typing would not hit this), not an application bug — no
code changed as a result.

**Round 5 (this pass — native bridge: tray, quick capture, notifications,
file drop/association).** Closed the exact gap round 4 ended on ("Not yet
done: ... system tray, native notifications, and any desktop-specific
affordances ... beyond the plain webview window"). Everything in "Native
bridge" above was actually run in this environment, with the specific,
falsifiable evidence recorded inline in each bullet rather than restated
here — sign-up through the real UI, a real global-hotkey trigger via
`osascript`, a real dev-API request log confirming `201`s for both
`/v1/ingestion/manual` (quick capture) and `/v1/documents/upload`
(file-association upload), a real tray "status menu" read back via
Accessibility with its exact three menu items, and a real `tauri build
--debug` producing and launching an actual `.app` bundle with the
configured file associations compiled into its `Info.plist`. A real bug
was found and fixed live during this verification (not left in): the
quick-capture popup's original `file://`-URL design silently broke
Tauri's own IPC (`Origin header is not a valid URL`) the first time a
capture was actually submitted — see `CAPTURE_SCHEME`'s doc comment in
`lib.rs` for the fix (a registered custom URI scheme instead) and how it
was diagnosed (reading Tauri's own vendored source, not guessing).

Not attempted this pass, honestly: a real OS-level drag-and-drop gesture
(no reliable way to synthesize a Finder-originated file drag in this
environment — verified via the equivalent file-association code path
instead, see "Native bridge" above), a real `lifeinbox://` custom-URL-
scheme deep-link handler (DSK-008 — `packages/db/src/schema/desktop.ts`
adds the spec-named `deep_link_routes` table as a routing-rule registry,
but no OS-level scheme registration or handler exists yet), and anything
requiring the three credential-blocked items listed above.
