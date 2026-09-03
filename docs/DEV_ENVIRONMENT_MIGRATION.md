# Moving primary development to the tower, keeping macOS/iOS testing on this MacBook

This documents how to split the Veynlo dev environment across two machines: the **tower** does the
real work (API, web, admin, Postgres/Redis/MinIO/ClamAV, Android development), and **this MacBook**
is kept around only for what genuinely requires macOS — building and running the iOS app in Xcode /
the iOS Simulator, since Apple's toolchain doesn't run anywhere else.

The reasoning: this MacBook has a small internal boot disk (~460GB total, most of it already
claimed by macOS/Xcode/other apps) shared between everything — Xcode's DerivedData, the iOS
Simulator's OS runtimes, Docker Desktop's own VM disk image, and this repo's `node_modules` all
compete for the same limited free space, which is exactly what caused a hard "disk full" stop
during this session (traced to an accidentally-duplicated project checkout plus several unused iOS
simulator runtimes Xcode had silently downloaded — since cleaned up, see git history around this
date for what was removed). A tower-class machine with real RAM and disk headroom removes that
ceiling entirely for everything except iOS.

## What moves to the tower

- The git repository itself (`veynlo-src`) — clone fresh there rather than copying this checkout,
  so you get a clean history and no leftover local-only files.
- `infrastructure/docker` — Postgres+pgvector, Redis, MinIO, Mailhog, ClamAV. These have no reason
  to run on a laptop; a tower with more RAM will run them (and the full test suite, which spins up
  real Postgres per test file) noticeably faster.
- `services/api`, `apps/web`, `apps/admin` — the three Node dev servers (`pnpm dev`).
- Android development — `apps/mobile` on Android (`expo run:android`, the Android emulator, or a
  real device over USB/Wi-Fi debugging). Nothing about Android requires a Mac; if the tower runs
  Windows, install Android Studio there directly (better emulator performance than this Mac has
  been getting, since Android's emulator wants hardware virtualization and real RAM, not a
  memory-constrained laptop already running Xcode).
- Claude Code sessions doing the actual feature work — point future sessions at the tower checkout
  instead of this Mac's, using this session's existing Remote Control connection to that machine
  (it already shows up as a peer session; a fresh session there just needs `cd` into the cloned repo).

## What stays on this MacBook

- Xcode itself, the iOS Simulator, and `expo run:ios` — no way around this, Apple requires macOS
  for iOS builds and simulator use.
- A **read-only-in-practice** checkout of the mobile app (`apps/mobile`) just deep enough to run
  `expo run:ios` and `pod install` — you won't be editing code here, just building and testing what
  was written on the tower.
- Nothing else needs to live here. The API/web/admin dev servers, Postgres, and all the actual
  editing/building for every other part of the app move to the tower.

## One-time tower setup

1. **Prerequisites** (matches this repo's own `README.md` "Quick start"):
   - Node 20+, pnpm 10+ (`corepack enable` is the easiest way to get the right pnpm version).
   - Docker — Docker Desktop on Windows/macOS, or plain Docker Engine on Linux. If the tower runs
     Windows, install Docker Desktop with the **WSL2 backend** (not the older Hyper-V backend) —
     it's faster and lets you run the whole toolchain (Node, pnpm, git) inside a WSL2 Ubuntu
     distro, which behaves identically to a native Linux dev environment. If the tower already runs
     Linux, none of this WSL2 detail applies — just install Docker Engine normally.
   - If you'll also do Android development there: Android Studio (bundles the Android SDK, an
     emulator with proper hardware acceleration on a real desktop GPU/CPU, and `adb`).

2. **Clone the repository**:
   ```bash
   git clone <your remote URL for this repo> veynlo-src
   cd veynlo-src
   pnpm install

   # Build the shared workspace packages before touching typecheck/tests/dev — every app/
   # service resolves @veynlo/core, @veynlo/db, etc. via their package.json "main"/"exports",
   # which point at ./dist, and that doesn't exist until this runs. Skipping this fails
   # typecheck with TS2307 "Cannot find module '@veynlo/core'" and vitest with "Failed to
   # resolve entry for package @veynlo/core" — platform-independent, same failure on Windows,
   # macOS, or Linux.
   pnpm --filter "./packages/*" run build
   ```

3. **Bring up local infra**:
   ```bash
   cd infrastructure/docker && docker compose up -d && cd ../..

   # Uses the compose network + the "minio" service's own DNS name rather than --network
   # host — host networking doesn't behave the same on Windows/macOS Docker Desktop as it
   # does on Linux, so this form is the one that actually works identically on all three.
   docker run --rm --network veynlo_default --entrypoint sh minio/mc:latest -c \
     "mc alias set local http://minio:9000 veynlo veynlo_dev_password && mc mb -p local/veynlo-documents"
   pnpm db:migrate
   pnpm db:seed
   ```

4. **Environment files** — copy each `.env.example` to its real filename and fill in secrets:
   ```bash
   cp services/api/.env.example services/api/.env
   cp apps/web/.env.example apps/web/.env.local
   cp apps/admin/.env.example apps/admin/.env.local
   cp apps/mobile/.env.example apps/mobile/.env.local
   ```
   **Never commit or transfer these `.env`/`.env.local` files through git** — they're already
   git-ignored, and that must stay true. Move any real secret values (API keys, the four
   `SESSION_JWT_SECRET`/`DEEPLINK_SIGNING_SECRET`/`CREDENTIAL_ENCRYPTION_KEY`/
   `FIELD_ENCRYPTION_KEY` values, etc.) from this Mac to the tower using a password manager's
   secure-note feature, `1Password`/`Bitwarden` CLI, or at minimum an encrypted archive over a
   private channel — never Slack, email, or a plain file share. If this Mac's `.env` files are
   currently only using the dev-default insecure placeholder values (the ones literally named
   `dev-only-...-change-me` in `.env.example`), there's nothing sensitive to transfer — just
   regenerate fresh ones on the tower with `openssl rand -base64 32`, same as any other fresh
   dev setup.

5. **Create your admin account and start everything**:
   ```bash
   pnpm --filter @veynlo/api run create-admin -- --email you@veynlo.app --role superadmin
   pnpm dev
   ```

At this point the tower is running API (`:4000`), web (`:3000`), and admin (`:3100`) exactly like
this Mac has been, plus Postgres/Redis/MinIO/Mailhog/ClamAV in Docker.

## Making the tower reachable from this Mac (for iOS testing)

The iOS Simulator on this Mac needs to talk to the API running on the tower instead of
`localhost:4000`. Two ways to do this, in order of preference:

- **If both machines are on the same LAN**: find the tower's LAN IP (e.g. `192.168.1.50`) and point
  the mobile app's `.env.local` on this Mac at it:
  ```
  EXPO_PUBLIC_API_URL=http://192.168.1.50:4000
  ```
  (check `apps/mobile/.env.example` for the exact variable name if it's changed by the time you do
  this — it may also be read from `app.json`/`app.config.ts` depending on how it's wired). The web
  app (`apps/web/.env.local`'s `NEXT_PUBLIC_API_URL`) on the tower itself doesn't need to change —
  it's already talking to its own localhost.
- **If you already use Tailscale, or set it up** (recommended if the tower isn't always on the same
  network as this Mac — e.g. a laptop that travels): install Tailscale on both machines, and use the
  tower's Tailscale IP/hostname (`http://tower.your-tailnet.ts.net:4000`) instead of a raw LAN IP.
  This keeps working over VPN, from a coffee shop, wherever this Mac happens to be, without router
  port-forwarding or exposing the API to the public internet.

Also update `WEB_APP_URL`/`API_PUBLIC_URL` in the tower's `services/api/.env` only if you need the
API to generate links (e.g. email links, OAuth redirect URIs) that resolve correctly from this Mac's
network — for pure API-call testing from the Simulator, the client-side `EXPO_PUBLIC_API_URL` change
above is the only thing that matters.

## Day-to-day workflow after migration

1. Do the actual feature work on the tower — either sitting at it directly, or via a Claude Code
   Remote Control session pointed at that machine (already available as a peer session from this
   one; a fresh session there just needs to `cd` into the cloned repo and pick up from there).
2. When you want to check the iOS build: on this Mac, `cd apps/mobile && npx expo run:ios` (or
   just `npx expo start` and press `i` if the native project hasn't changed and you just need a
   fresh JS bundle) — pointed at the tower's API per the networking setup above.
3. Keep this Mac's `apps/mobile` checkout in sync by pulling from git before each iOS test session
   — you're not editing here, just pulling what was built on the tower and confirming it looks/
   works right on a real Apple toolchain.
4. If Xcode's DerivedData or the iOS Simulator's runtimes fill this Mac's disk again, the fix from
   earlier in this session still applies: `rm -rf ~/Library/Developer/Xcode/DerivedData` (Xcode
   regenerates it, nothing is lost) and `xcrun simctl runtime list` / `xcrun simctl runtime delete
   <id>` to remove any iOS/watchOS runtime versions you're not actually testing against — this repo
   only needs whichever single iOS version your target Simulator device uses.

## What this does *not* solve

Moving primary development to the tower fixes the resource-contention problem for the API/web/
admin/Postgres/Android side of things. It does **not** give you a working Android emulator on this
Mac — if the tower is Android's actual home now, that's fine and expected, this Mac was never going
to reliably run one anyway given the disk/memory constraints hit this session. It also does not
solve any future macOS-side Xcode/Simulator resource issues — Xcode itself needs real disk headroom
regardless of which machine everything else lives on, which is why the DerivedData/runtime cleanup
note above is worth remembering, not just a one-time fix.
