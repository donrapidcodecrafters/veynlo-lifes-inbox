# What Don Still Needs To Buy, Sign Up For, Or Hand Me

**Purpose:** get five people testing Veynlo on their own phones, without paying for anything the app
does not actually use yet.

**How to read this.** Everything in §1 is free or already done. §2 is the only unavoidable spend, and it
is small. §3 is the hosting decision, where the money actually is. §4 is optional and most of it can wait
— each item says what breaks if you skip it, so you can decide rather than guess.

**On accuracy.** Every "required / optional / degrades to X" claim below was checked against the code in
this repo, and the file is named. Dollar figures are **estimates** and are marked as such — AWS and app
store pricing changes and varies by region, so treat the AWS Pricing Calculator and the vendors' own
pricing pages as authoritative, not this document. Where I could not verify something, §6 says so
explicitly rather than guessing.

---

## 0. What you have already provided — verified 2026-09-10

You told me these were already supplied, and you were right: they are on the **MacBook**, not the tower.
This is the masked inventory from `services/api/.env` there (values never transmitted — names, lengths
and first characters only).

| Credential | Status | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Present and PROVEN WORKING** | Not merely "set" — the Mac drove a real Ask query end to end: `POST /v1/ask -> 201`, 3.7s, a coherent answer citing the actual seeded bills. That timing rules out the local not-configured fallback, which returns instantly |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Present | 72 and 35 chars, correct prefixes |
| `MICROSOFT_OAUTH_CLIENT_ID` / `_SECRET` | Present | 36 and 40 chars |
| `APPLE_CLIENT_ID` | Present | `app.…`, 24 chars |
| `APPLE_TEAM_ID` | Present | **`Q222B28WK6`** — not secret, appears in every provisioning profile |
| `APPLE_KEY_ID` | Present | 10 chars |
| **`APPLE_PRIVATE_KEY`** | **RESOLVED 2026-09-10** | Was a 27-character placeholder — just the `BEGIN PRIVATE KEY` header line with no body. Since replaced with a real key; the Mac confirmed it imports via `jose.importPKCS8()`. Apple sign-in is live there |
| Stripe / RevenueCat / Plaid | Absent or empty | Not needed for testing — §4g |
| SMTP | Points at local Mailhog | Fine for dev; §4f for testers |
| Inbound email | Absent | Not needed — §4g |

**None of these are on the tower**, which is why my Android sweep has never once exercised the AI code
path. Moving them across is a real (if minor) unblock for audit coverage, not just tidiness.

### The Apple private key was a placeholder — now resolved, and it had been hiding a bug

**Status: fixed.** The key is real as of 2026-09-10. This section is kept because the bug it exposed is
the part worth remembering.

The old value was 27 characters — a truncated placeholder that could not sign anything.

Worse, it **passed** the app's own configuration check, because `isAppleSignInConfigured()` only tested
that the four Apple variables were non-empty. So the API advertised Apple sign-in as available, the app
rendered the "Sign in with Apple" button, and pressing it would have thrown inside `importPKCS8()` and
surfaced as a `500 INTERNAL_ERROR` marked **retryable** — a configuration fault reported as a transient
one, which no amount of retrying could fix.

Fixed in commit `9360ea2` — shape validation plus a catch, so a bad key produces a clean
`oauth_not_configured` instead of a 500.

**Correction (2026-09-10).** An earlier version of this document said the fix makes "the button now
correctly hide instead of failing". **That was wrong**, caught by the Mac session checking the client code
rather than taking my word. The Apple button renders **unconditionally** on both
`apps/web/src/app/(auth)/sign-in/page.tsx` and `apps/mobile/src/components/oauth-sign-in-buttons.tsx` —
nothing gates it on configuration, and `9360ea2` changed server behaviour only.

What actually happens when a provider is unconfigured: pressing the button hits `/v1/auth/<provider>/authorize`,
which throws `OAuthNotConfiguredError`, and the user is redirected to `/sign-in?error=oauth_not_configured`
(or `veynlo://auth-callback?error=…` on native) where both clients show *"That sign-in method isn't
configured on this deployment yet."* So it is handled and honest — but it degrades **after** the click
rather than before it, which is a UX wart rather than a fault. Recorded as such rather than
overstated.

**Also (2026-09-10): the key has since been replaced with a real one.** The Mac confirmed
`APPLE_PRIVATE_KEY` now imports successfully via `jose.importPKCS8()`, so
`isAppleSignInConfigured()` returns true on that machine and Apple sign-in is live there. The steps below
are kept only for the case where the key is ever lost again.

1. <https://developer.apple.com/account/resources/authkeys/list>
2. If a Sign in with Apple key already exists, note its Key ID — but **the `.p8` file itself can only be
   downloaded once, at creation**. If you no longer have the file, revoke that key and create a new one.
3. Create a key, tick **Sign in with Apple**, download the `.p8`.
4. The value for `APPLE_PRIVATE_KEY` is the **entire file contents** including both `-----BEGIN` and
   `-----END` lines — not a file path. `env.ts` documents this explicitly.

### Apple Developer membership — CONFIRMED ACTIVE

Don confirmed 2026-09-10 that the Apple Developer Program membership is **paid and active**. So §2a is
already done and the $99 is already spent: TestFlight is available as soon as there is a build to submit.

**Nothing Apple-related is outstanding.** The membership is live, the Team ID is known, and the `.p8` has
been replaced with a real key. Note for future reference: Sign in with Apple and shipping a TestFlight
build are independent — a missing `.p8` would never have blocked a release, only that one sign-in option.

### Google Play — still open, and probably unnecessary

Two separate things, which is what my original question conflated:

1. **A Play Console developer account** — the $25 one-time registration, i.e. you as a publisher.
2. **An app entry inside that account** — created with "Create app". The Android package name
   (`app.veynlo.mobile`) binds to it permanently on first upload and can never be changed.

Check at <https://play.google.com/console>: a dashboard with a "Create app" button and no Veynlo listed
means the account exists but the app entry does not.

**Neither is required to get five people testing on Android.** `eas build --profile preview` produces a
plain `.apk` that testers install from a link — free, instant, no Google account involved. Pay the $25
only if you want Play's update delivery or intend to go beyond testing. See §5b.

---

## 1. What you do NOT need to pay for

This is the part worth reading first, because the app is designed to run without most of its
integrations.

**Every external integration degrades to a visible "not configured" state rather than breaking.** That
is a deliberate property of the codebase, not an accident — `services/api/src/config/env.ts` marks them
`.optional()`, and each controller returns its own `*_NOT_CONFIGURED` error code. Connections screens say
so in the UI instead of pretending to work.

Specifically, **your five testers can sign up and use the core product with zero third-party
credentials**:

- **Sign-up needs no email provider.** `IdentityService.signUp` creates the user with `status: "active"`
  directly — there is no email-verification gate to pass. Verified in
  `services/api/src/modules/identity/identity.service.ts`.
- Capture, Inbox, Life (people/pets/home/vehicles/places/trips), Lists, Saved items, Settings,
  Households, Sharing, Search and the Timeline all work against your own database with no external
  service.
- Password reset and notification emails will not arrive without SMTP — testers just need to not forget
  their passwords, or you reset them directly in the database.

**The four production secrets are free.** You generate them yourself:

```bash
openssl rand -base64 32     # run four times
```

Set `SESSION_JWT_SECRET`, `DEEPLINK_SIGNING_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
`FIELD_ENCRYPTION_KEY`. The API **refuses to start** in production if any is missing, too short, or left
at its dev default — see `PRODUCTION_REQUIRED_SECRETS` in `env.ts`. Store them somewhere you will not
lose them: `FIELD_ENCRYPTION_KEY` encrypts user data at rest, and losing it means losing that data.

---

## 2. The unavoidable spend: getting the app onto testers' phones

**Total outstanding: $0.** The Apple membership is already paid and active (confirmed by Don), and the $25 Google fee is optional — see §2b. Both are recorded here for completeness rather than as things to buy.

### 2a. Apple Developer Program — **ALREADY PAID AND ACTIVE** (confirmed 2026-09-10)

Nothing to do here. Membership is live and the Team ID is `Q222B28WK6`. TestFlight is available as soon
as there is a build to submit — see §5d.

Two notes for when we get there:

- The iOS bundle identifier is already `app.veynlo.mobile` (`apps/mobile/app.json`). Either register it
  yourself under Certificates, Identifiers & Profiles, or let EAS create it during the first build — EAS
  handles certificates and provisioning profiles for you if you let it.
- **Sign in with Apple is a separate thing from shipping a build.** It needs the real `.p8` described in
  §0. Without it the app simply will not offer Apple as a sign-in option; testers use email and password.
  Do not treat that as blocking a TestFlight release.

### 2b. Google Play Console — **$25 one-time**, required for Android via Play

1. Go to <https://play.google.com/console/signup>.
2. Pay the one-off $25 registration fee. Individual accounts now require identity verification, which can
   take a few days.
3. Create an app with package name **`app.veynlo.mobile`** (already set in `apps/mobile/app.json` — it
   must match exactly and **cannot be changed after the first upload**).
4. Use **Internal testing**, not Open or Closed testing: it allows up to 100 testers, and builds go live
   within minutes rather than waiting on review.

**You can skip this entirely for Android if you want.** EAS can build a plain `.apk`
(`apps/mobile/eas.json` already has a `preview` profile with `"buildType": "apk"`) that testers install
directly by downloading a link and allowing "install from unknown sources". That is free, immediate, and
fine for five people. The $25 is worth paying only if you want Play Store update delivery or plan to go
further than testing.

### 2c. Expo / EAS — probably free

`apps/mobile/app.json` already carries `owner: "veynlo"` and an EAS `projectId`
(`382a46c2-6741-4cc0-aa69-981f3623f2c9`), so an Expo account appears to exist already. **Please confirm
you can log into <https://expo.dev> with it** — if you cannot, that project ID needs replacing and I need
to know.

EAS Build's free tier gives a limited number of builds per month with queue priority behind paid users.
For five testers and occasional rebuilds that is usually enough. The paid tier starts around **$19/month**
(verify current pricing at <https://expo.dev/pricing>) and mainly buys faster queues and more builds — do
not buy it until a slow queue actually annoys you.

---

## 3. Hosting — where the real money is, and how to keep it small

This is the decision that matters. **I strongly recommend Option A for five testers.**

### Option A — one small server. **Estimated $15–30/month.** Recommended.

Everything already runs as containers via
`infrastructure/docker/docker-compose.yml` (Postgres 17 + pgvector, Redis, MinIO, Mailhog, ClamAV) and
`services/api/Dockerfile` builds both the `api` and `worker` targets. That whole stack fits comfortably on
one small ARM instance.

- **AWS Lightsail**, 2 GB RAM / 2 vCPU instance — roughly **$12/month** at time of writing, flat rate,
  bandwidth included. Simplest option, predictable bill.
- **Or EC2** `t4g.small` (ARM/Graviton, 2 GB) — similar compute cost plus separate EBS and data-transfer
  charges, so slightly more to reason about.
- **Plus S3** for document uploads — for five testers this is pennies per month.

Five concurrent testers is a trivial load: this is a handful of HTTP requests per second at worst.

**What this does not give you:** no automatic failover, no managed backups unless you set them up, and
you are responsible for OS patching. For a five-person test that is the right trade.

**Steps:**
1. Create the AWS account (§3c below).
2. Launch the instance, open ports 80/443 only.
3. Install Docker and Docker Compose.
4. Clone the repo, copy `services/api/.env.example` to `.env`, fill in the four generated secrets from §1.
5. Point a domain at the instance and terminate TLS with Caddy or nginx — Caddy gets you a free Let's
   Encrypt certificate with about three lines of config.
6. `pnpm db:migrate`, then start the API and worker containers.
7. Set `API_PUBLIC_URL`, `WEB_APP_URL`, `ADMIN_APP_URL` to the real URLs, and build the mobile app with
   `EXPO_PUBLIC_API_URL` pointing at the API.

### Option B — the Terraform stack in this repo. **Estimated $300–450/month.** Not recommended yet.

`infrastructure/terraform/` already defines Aurora PostgreSQL Serverless v2, ElastiCache Valkey
Serverless, ECS Fargate on ARM64, and an ALB. It is written and structurally sound but **has never been
applied against a real AWS account** (`infrastructure/terraform/README.md` says so directly).

It is expensive for five testers because of what it provisions continuously, not because of load:

- Aurora Serverless v2 is configured with **`min_acu = 2`** (`modules/database/variables.tf`). Serverless
  v2 bills its *minimum* capacity around the clock whether or not anyone is using it — that alone is
  likely **$150–200/month**.
- An ALB has a fixed hourly charge regardless of traffic (~**$20/month**).
- NAT Gateways, if the private-subnet layout uses them, are ~**$32/month each** plus data processing.
- Two Fargate services at 1 vCPU / 2 GB each (`modules/ecs-service/variables.tf`) run continuously.

That architecture is the right target for real customers. It is the wrong target for five testers. **Do
not apply it yet.**

### 3c. Creating the AWS account (needed for either option)

1. <https://portal.aws.amazon.com/billing/signup> — needs an email, a credit card, and a phone
   verification.
2. **Immediately** turn on MFA for the root user, then stop using the root user.
3. Create an IAM user (or Identity Center user) for day-to-day work.
4. **Set a billing alarm before you deploy anything** — Billing → Budgets → a monthly budget with an email
   alert at, say, $50. This is the single most useful thing you can do to avoid a surprise bill.
5. Give me: the region you want (`us-east-1` is cheapest and simplest unless you have a reason), and
   either credentials for a deploy user or a way to hand them over securely.

---

## 4. Optional integrations — what each one costs and what breaks without it

Ordered by how much a tester would actually miss it. **None of these blocks testing.**

### 4a. Anthropic API key — the only one I would consider buying now

**What breaks without it:** the AI half of the product. Ask returns "not configured", automation rules
cannot be created from natural language (`AI_NOT_CONFIGURED` in
`automation.service.ts`), and email/document extraction falls back to non-AI paths
(`ingestion.service.ts`, `documents.service.ts` both branch on `this.ai.isConfigured()`).

Everything else keeps working. But if you want testers to evaluate what makes Veynlo *Veynlo*, this is the
one to have.

**Cost:** pay-as-you-go by token, no subscription. Five testers doing light testing is realistically a few
dollars a month, but it is genuinely usage-dependent — **set a spend limit in the console**.

**Steps:** <https://console.anthropic.com> → sign up → Billing → add credit → API Keys → create key →
set `ANTHROPIC_API_KEY`. Set a monthly spend cap while you are in there.

### 4b. Google OAuth (Gmail connector + Sign in with Google) — free, but slow

**What breaks without it:** the Gmail connector and Google calendar sync show "not configured"; Google
sign-in is hidden. Users sign up with email and password instead.

**Cost:** free.

**The catch:** Gmail read access is a **restricted scope**. Google requires an OAuth verification review,
and for restricted scopes that includes a third-party security assessment which is expensive and takes
weeks. **For five testers you do not need any of that** — add the five testers' Google accounts as **Test
users** on the OAuth consent screen while it is in "Testing" status, and it works immediately with a
scary-looking "unverified app" warning they can click through. Testing mode allows up to 100 test users.

**Steps:** <https://console.cloud.google.com> → new project → APIs & Services → OAuth consent screen →
External → add the five testers under Test users → Credentials → Create OAuth client ID (Web
application) → add your API's callback URL as an authorised redirect URI → gives you
`GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. Enable the Gmail API and Google Calendar API
under Library.

### 4c. Microsoft OAuth (Outlook connector) — free

Same shape as Google, less painful. <https://portal.azure.com> → Microsoft Entra ID → App registrations →
New registration → multi-tenant → Certificates & secrets → new client secret. Gives you
`MICROSOFT_OAUTH_CLIENT_ID` and `MICROSOFT_OAUTH_CLIENT_SECRET`.

### 4d. Sign in with Apple — free *if* you already paid §2a

Only worth wiring if testers want to sign in with Apple. Needs four values together
(`APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`) — the Services ID, your Team
ID, the Key ID, and the `.p8` private key's **contents** (not a path — `env.ts` documents this
explicitly). Created under Certificates, Identifiers & Profiles → Keys → enable "Sign in with Apple".
**The .p8 downloads exactly once.**

### 4e. Push notifications — free, but needs one file per platform

Push goes through **Expo's push service** (`expo-server-sdk` in
`services/api/src/modules/notifications/push.service.ts`), so there is no separate paid service.

- **Android:** create a free Firebase project, download the FCM V1 service-account JSON, upload it to
  Expo (`eas credentials`). No cost.
- **iOS:** needs an APNs key from the Apple Developer account in §2a. No extra cost beyond the $99.

**What breaks without it:** in-app notifications still work; nothing arrives on the lock screen.

### 4f. SMTP / outbound email — free tier available

**What breaks without it:** password-reset emails and daily/weekly brief emails never arrive. Sign-up
still works (see §1).

Locally this points at Mailhog. For testers, a free tier from Postmark, Mailgun, SendGrid or AWS SES is
enough. **SES is cheapest** if you are already on AWS (fractions of a cent per email) but starts in a
sandbox that only sends to verified addresses — fine for five known testers, and you can verify their five
addresses in minutes. Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM_ADDRESS`.

### 4g. Everything below here can wait — do not buy these yet

| Service | Env vars | What breaks without it | Cost |
|---|---|---|---|
| **Plaid** | `PLAID_CLIENT_ID`, `PLAID_SECRET` | Bank/finance connector shows "not configured". `PLAID_ENV` defaults to `sandbox`, which is **free** and enough to demo the flow with fake banks | Free sandbox; production is a paid partner contract |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_*` | Billing page returns an empty plan list. Testers do not need to pay you | Free to set up; % per transaction |
| **RevenueCat** | `REVENUECAT_WEBHOOK_AUTH_HEADER` | Mobile subscription entitlements not synced | Free under a revenue threshold |
| **Inbound email** | `INBOUND_EMAIL_DOMAIN`, `INBOUND_EMAIL_WEBHOOK_SECRET` | The "forward to your Life Inbox" address does not exist. Needs its own domain with SPF/DKIM/DMARC | Provider-dependent |
| **Dropbox** | `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET` | Dropbox connector unavailable. Needs its own app registration | Free |
| **ClamAV** | `CLAMD_HOST` | Document uploads are **not virus-scanned**. Uploads still work | Free — it is a container, already in the local compose file |
| **Maps / geocoding** | `MAPS_PROVIDER_API_KEY` | Travel-time estimates stay straight-line with a visible "rough estimate" disclosure. See `docs/PHASE3_PENDING_CREDENTIALS.md` — this one also needs code work, not just a key | Paid per request |

---

## 5. Deploying to testers, step by step

**Prerequisite:** the API must be reachable on a real HTTPS URL (§3), because testers' phones cannot reach
`localhost`.

### 5a. One-time setup

```bash
npm install -g eas-cli
eas login                          # the Expo account from §2c
cd apps/mobile
```

Set `EXPO_PUBLIC_API_URL` to your real API URL before building — it is baked into the build
(`apps/mobile/src/lib/api-client.ts`).

### 5b. Android — the fast path (no Play Console, free)

```bash
eas build --platform android --profile preview
```

`eas.json`'s `preview` profile already produces an `.apk` with internal distribution. EAS gives you a URL;
send it to testers, they open it on the phone, allow installs from unknown sources, done. **This is the
quickest way to get five people testing and costs nothing.**

### 5c. Android — via Play Internal Testing (needs §2b)

```bash
eas build --platform android --profile production
eas submit --platform android --latest
```

Then in Play Console: Testing → Internal testing → create a release → add testers by email (up to 100) →
share the opt-in link. Live within minutes, no review wait.

### 5d. iOS — TestFlight (needs §2a; there is no free alternative)

```bash
eas build --platform ios --profile production
eas submit --platform ios --latest
```

EAS will prompt for your Apple credentials and can generate the certificates and provisioning profiles for
you. Then in App Store Connect: TestFlight → Internal Testing → add testers (up to 100 internal testers,
who must be members of your team) or External Testing (up to 10,000, but the **first** external build
needs a Beta App Review, usually a day or two).

For five people, **Internal Testing is the right choice** — no review, available in minutes after
processing.

### 5e. Rebuilding after changes

JavaScript-only changes can ship over the air with `eas update` without a new store build. Anything that
changes native code or `app.json` needs a fresh build and resubmission.

---

## 6. What I could not verify, and what I need from you

**Not verified — please confirm:**

1. **The Expo account.** `app.json` names owner `veynlo` and a project ID. I cannot check whether you
   control that account. If you cannot log in at expo.dev, tell me and I will change the config.
2. **Domain ownership.** `env.ts` defaults reference `veynlo.app` / `api.veynlo.com`. I do not know
   whether you own either. Testing needs one domain you control with DNS access.
3. **All dollar figures.** Estimates only, from general knowledge, not from your account. Verify at
   <https://calculator.aws> and each vendor's pricing page before committing.
4. **No production deployment exists.** `docs/DEPLOYMENT.md` states this plainly, and I confirmed no
   AWS account is referenced anywhere in the repo. Everything in §3 is a first-time setup.

**The shortest path to five testers, if you want to spend as little as possible:**

1. Generate the four secrets (free, five minutes).
2. Create the AWS account, set a $50 budget alarm, launch one Lightsail instance (~$12/month).
3. Point a domain at it with Caddy for TLS.
4. `eas build --platform android --profile preview` → send the APK link to your Android testers (free).
5. Pay the $99 Apple fee only when an iPhone tester actually needs to be included.
6. Add the Anthropic key when you want the AI features evaluated (a few dollars, capped).

That gets Android testers running for about **$12/month plus a domain**, and iPhone testers for that plus
**$99/year**. Everything else in this document can wait until something specific is needed.

---

*Companion documents: `docs/DEPLOYMENT.md` (what runs today and the intended AWS path),
`docs/PHASE2_PENDING_CREDENTIALS.md` and `docs/PHASE3_PENDING_CREDENTIALS.md` (per-feature detail on what
each missing credential would unlock), `services/api/.env.example` (every variable with inline notes),
`docs/VENDOR_REGISTER.md` (vendor list).*
