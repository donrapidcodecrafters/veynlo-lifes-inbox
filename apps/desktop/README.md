# Veynlo desktop (Tauri)

A native macOS/Windows/Linux shell around the real Veynlo web app
(`apps/web`) — not a separate frontend. The window loads `apps/web`
directly (`http://localhost:3000` in dev, configured in
`src-tauri/tauri.conf.json`'s `app.windows[0].url`), so every feature that
works in the browser works here identically, with no duplicated UI code.
This mirrors how `expo start --web` gives the mobile app a real-browser
preview path — the desktop app is the same idea in the other direction: a
native window around the web build.

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
pnpm exec tauri build
```

Produces a signed-for-local-use `.app` bundle and `.dmg` under
`src-tauri/target/release/bundle/`. Before this leaves local dev: point
`app.windows[0].url` at the real production web app origin instead of
`localhost:3000` (the same "needs real config for prod" pattern used for
Gmail OAuth/Anthropic/Stripe elsewhere in this repo), and set up real code
signing/notarization for macOS and Authenticode for Windows — an unsigned
build will trigger Gatekeeper/SmartScreen warnings.

## Icons

`src-tauri/icons/*` were generated from a single 1024×1024 placeholder
brand-color PNG via `pnpm exec tauri icon <source.png>` (Tauri's own CLI
does the ICNS/ICO conversion — no external image tooling needed). Replace
the source PNG with a real designed icon and re-run that command before
any store/distribution build.

## Verified

Built and ran for real in this environment: installed a real Rust
toolchain via rustup (none was available at the start of this project),
`pnpm exec tauri dev` compiled cleanly (`Finished` \`dev\` profile, ~341
crates) and launched an actual native process (`target/debug/veynlo-desktop`,
confirmed via `ps`, listed among the machine's visible foreground apps
alongside Chrome/Excel/etc.) pointed at the live `apps/web` dev server
(confirmed reachable via `curl` immediately before launch). **Not verified
visually** — this session's `osascript`/System Events doesn't have
Accessibility permission granted, so a window screenshot of the running
app couldn't be captured; the process's clean compile, stable running
state (no crash/panic in the log), and OS-level process listing are the
verification evidence instead. Not yet done: production build/signing,
auto-update, system tray, native notifications, and any desktop-specific
affordances (global shortcuts, native menu bar) beyond the plain
webview window.
