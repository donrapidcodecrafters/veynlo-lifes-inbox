# Incident response

Blueprint §28 "Least-privilege... Protect administration/support functions... Create a documented
incident-response path before launch, including token revocation, key rotation, forced logout, provider
compromise, and user notification decisions."

This is a concrete operational runbook grounded in what this codebase actually has today, not a generic
"contact your CISO" template. Every action below names the real table, service method, or script it uses.
Where no real mechanism exists yet, that's stated plainly as a gap — a runbook that describes a control that
isn't actually there is worse than no runbook, because it gives a false sense of readiness during a real
incident.

**Owner**: single-developer repository today (see CODEOWNERS) — same person runs every step below until the
team grows. **Last verified**: 2026-09-01, against the live code paths cited.

## 1. Detection and severity triage

There is no dedicated security-alerting/SIEM pipeline yet (§SECURITY_CONTROLS.md's V7.4 gap — no
OpenTelemetry/Sentry installed). In practice, an incident is first noticed via one of:

- A user report (account behaving unexpectedly, unrecognized session/device in `GET /v1/auth/sessions`).
- An anomaly in `audit_events` (see `packages/db/src/schema/audit.ts`) — every login, recovery, OAuth
  change, household ACL change, bulk export/delete, and admin access writes a row here. This is the closest
  thing to an audit trail today; querying it directly (`psql`/a script) is the only current investigation
  tool, since there's no dashboard over it.
- A provider notice (Google/Microsoft/Stripe/RevenueCat flagging suspicious activity on Veynlo's own
  developer/merchant account, not a Veynlo user's).
- A dependency/secret-scanning alert from CI (gitleaks/semgrep — `.github/workflows/ci.yml`).

Severity is scoped along two independent axes, since the response differs by which:

- **Single user compromised** (stolen session, weak/reused password, phished OAuth grant) — contained
  entirely by sections 2-4 below.
- **Systemic** (a leaked `FIELD_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY`/`SESSION_JWT_SECRET`, a
  compromised connector app secret at Google/Microsoft/Plaid/Dropbox, a compromised admin account, or a
  vulnerability that could affect every user) — requires sections 5-7 as well, and almost certainly requires
  user notification (section 8).

## 2. Revoke a compromised user's session(s)

The fast, immediate, already-live control. `AuthGuard` (`services/api/src/common/auth.guard.ts`) re-checks
the backing `sessions` row on **every** request, not just at JWT issuance — so revocation takes effect on the
attacker's very next request, not at token expiry. This is the single most useful IR tool this app has today.

- **Self-service** (the account owner still has control): `POST /v1/auth/sessions/:id/revoke`
  (`IdentityService.revokeSessionById`) to kill one device, or `POST /v1/auth/sign-out-everywhere`
  (`IdentityService.revokeAllSessions`) to kill every session at once. Both set `sessions.revokedAt`, which
  `AuthGuard` checks unconditionally.
- **Operator-initiated** (the owner has reported compromise, or a systemic incident requires revoking many
  accounts at once): `POST /v1/admin/users/:userId/force-logout` (`AdminService.forceLogoutUser`) — calls
  the same `IdentityService.revokeAllSessions` the self-service "sign out everywhere" path above uses, so
  it's the identical, already-proven revocation mechanism, just reachable by support. Gated at the ordinary
  `AdminGuard` (support tier), not `SuperAdminGuard` — this is a routine, reversible, non-account-management
  action (a live session dying and needing to sign back in), the same tier as entitlement grant/revoke and
  merchant merge; `SuperAdminGuard` is reserved for admin-*account* management (creating/revoking operator
  accounts — see `admin.controller.ts`'s own comment on that boundary). Audited via
  `AdminService.recordAccess` → `admin.user_force_logout`, same as every other admin action. Live-verified
  end to end: a real user's session worked (`GET /v1/auth/me` returned 200), an admin called force-logout,
  and the exact same session cookie immediately started returning `401 Session revoked`.
- **Refresh-token reuse detection already fires automatically**: `IdentityService.refreshSession` revokes
  the whole session outright if an already-rotated refresh token is replayed (see the `reused` check around
  line 310) — this is a signal worth treating as a standing incident indicator, not just a one-off defense;
  if it fires for a real user, that's worth investigating as a likely token-theft attempt even though the
  session was already auto-revoked.

## 3. Force a password reset

There's no "admin sets a temporary password" flow (correctly — that would mean an operator handling a raw
password). The real controls:

- **User-initiated**: `POST /v1/auth/forgot-password` → `IdentityService.forgotPassword` issues a
  single-use, hashed, 1-hour-expiry token (`password_reset_tokens`) and emails a reset link. Same flow
  whether the user requests it themselves or is told to by support during an incident call.
- **Operator-forced invalidation of the *current* password** (e.g. a leaked-credential report where the
  user hasn't acted yet): there is no direct "admin invalidates this password hash" endpoint. The safe
  interim action is to revoke every session (section 2) — that stops an active attacker even before the
  password itself is changed — and instruct the user to complete `forgot-password` themselves. Directly
  nulling `users.passwordHash` would lock the user out entirely (the schema requires it for a password
  account) rather than gracefully forcing a reset, so don't do that as a shortcut.
- Password hashes are argon2id (`identity.service.ts`) — if the database itself leaked, hashes are not
  reversible in practice, but treat it as a full-population password-reset event anyway (see section 8) since
  reused passwords elsewhere are the real residual risk, not this hash.

## 4. Provider (connector) compromise — Gmail/Outlook/Google Drive/OneDrive/Dropbox/Plaid

If a specific OAuth provider is compromised (a leaked Veynlo-side client secret, a provider-reported breach,
or evidence a specific user's provider account was phished):

- **Revoke the stored token**: `ConnectorsService.disconnect(connectionId, userId, ...)`
  (`services/api/src/modules/connectors/connectors.service.ts`) deletes the `connection_credentials` row
  unconditionally (not just on `deleteDerivedData`) — the token stops being decryptable by this app
  immediately. For Plaid specifically it also calls `plaid.revoke()` to invalidate the Item upstream. For
  Gmail/Google Calendar/Google Drive/Google Tasks and Dropbox, disconnect now ALSO calls the provider's own
  token-revocation endpoint (`ConnectorsService.revokeProviderToken` — Google's
  `https://oauth2.googleapis.com/revoke`, Dropbox's `https://api.dropboxapi.com/2/auth/token/revoke`) before
  the local credential row is deleted, so a leaked/exfiltrated copy of the token (taken before Veynlo's own
  row was deleted) is also killed at the source, not just locally. Best-effort by design: a failed upstream
  revoke call is logged and swallowed, never blocking the disconnect — the local credential delete remains
  the actual security boundary. Microsoft-family connections (Outlook/Microsoft Calendar/OneDrive/Microsoft
  To Do) make no such call — Microsoft's v2 identity platform has no application-callable token-revocation
  endpoint at all; the user has to revoke consent themselves from their Microsoft account settings, or a
  tenant admin revokes it via Azure AD/Entra (see `MICROSOFT_NO_REVOKE_PROVIDERS`'s doc comment in
  `connectors.service.ts` for the full citation). This can't be live-verified against a real Google/Dropbox
  account in this dev environment (no real OAuth app configured — see
  `docs/PHASE2_PENDING_CREDENTIALS.md`), so it's proven with a real regression test that stubs `fetch` and
  asserts the exact request URL/method/token reaching it (`connectors.revoke-provider-token.test.ts`).
- **Systemic provider compromise** (Veynlo's own OAuth app secret leaked, not a single user's token): rotate
  the client secret in the provider's developer console immediately (this invalidates every existing
  authorization for that provider across all users at once, forcing re-consent), then update the
  corresponding env var (`GOOGLE_CLIENT_SECRET`/`MICROSOFT_CLIENT_SECRET`/etc. — see
  `services/api/.env.example`) and redeploy. Every connected user will need to reconnect; this is
  disruptive but correct.
- **A malicious/compromised mail relay injecting fake content** through the Gmail/Outlook/inbound-email
  path: see `docs/THREAT_MODEL.md` flow 2 — low-confidence extractions already route to the Inbox for human
  confirmation rather than auto-filing as fact, which limits (but doesn't eliminate) blast radius; a
  confirmed case should still trigger a `connectors.disconnect` for the affected connection while
  investigating.

## 5. Rotate `FIELD_ENCRYPTION_KEY` (application-layer field encryption)

`packages/db/src/crypto/field-encryption.ts` has a real, tested, versioned rotation mechanism — this is the
one key in the system actually designed for rotation without a hard cutover:

1. Set `FIELD_ENCRYPTION_KEY_PREVIOUS`/`FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION` to the outgoing (compromised)
   key and its version number.
2. Set `FIELD_ENCRYPTION_KEY`/`FIELD_ENCRYPTION_KEY_VERSION` to a newly generated key and a higher version
   number. Deploy.
3. Every *new* write is now encrypted under the new key; every *existing* row is still readable (the
   ciphertext carries its own key-version tag, and the previous key is still configured for decryption)
   but still sitting there encrypted under the compromised key.
4. Run a full backfill that reads and rewrites every encrypted column (touches every row across the 50+
   `encryptedText`/`encryptedJsonb` columns catalogued in `docs/THREAT_MODEL.md`'s asset inventory) so
   everything is re-encrypted under the new key.
5. Only after the backfill completes, remove the `_PREVIOUS` env vars. Until then, the compromised key must
   stay configured (as `_PREVIOUS`) or old rows become unreadable.
6. **Gap**: no backfill script exists in the repo today (`services/api/src/scripts/`) — this procedure is
   currently manual/undocumented-in-code. Given how central this key is (it decrypts the actual private-life
   content this product exists to protect), writing a real `rotate-field-encryption-key.ts` backfill script
   is worth prioritizing before this key handling any real user's data in production.

## 6. Rotate `CREDENTIAL_ENCRYPTION_KEY` (OAuth token vault)

`CredentialVault` (`services/api/src/common/credential-vault.ts`) now has the same real, tested,
versioned-key rotation mechanism `field-encryption.ts` has — this used to be the one gap in this doc that
was "a real, current gap, not a procedure"; it now IS a procedure, mirroring section 5's:

1. Set `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`/`CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION` to the outgoing
   (compromised) key and its version number.
2. Set `CREDENTIAL_ENCRYPTION_KEY`/`CREDENTIAL_ENCRYPTION_KEY_VERSION` to a newly generated key and a
   higher version number. Deploy.
3. Every *new* credential write (a fresh OAuth grant, a token refresh via `CredentialVault.rotate`) is now
   encrypted under the new key; every *existing* row is still readable (its ciphertext carries its own
   key-version tag, and the previous key is still configured for decryption) but still sitting there
   encrypted under the compromised key.
4. Run `pnpm --filter @veynlo/api run rotate-credential-vault-key`
   (`services/api/src/scripts/rotate-credential-vault-key.ts`) — unlike section 5's `FIELD_ENCRYPTION_KEY`
   backfill, this one already has a real, idempotent, re-runnable script: it walks every
   `connection_credentials` row and re-encrypts it under the current key (skipping rows already on it),
   reporting a rotated/skipped/failed count at the end.
5. Only after that script completes with zero failures, remove the `_PREVIOUS` env vars. Until then, the
   compromised key must stay configured (as `_PREVIOUS`) or old rows become unreadable.

No more forced mass-reconnect: a key rotation no longer requires every user to redo every OAuth grant.
Proven with a real regression test (`services/api/src/common/credential-vault.test.ts`) that stores a
credential under the old key, rotates, confirms it's still readable via the `_PREVIOUS` key, backfills it,
then confirms it stays readable with the `_PREVIOUS` key removed entirely (i.e. genuinely re-encrypted, not
just readable-by-luck).

## 7. `SESSION_JWT_SECRET` rotation (forced global logout)

No rotation mechanism exists for this one either — it's a single `HS256` secret
(`services/api/src/common/auth.guard.ts`, `identity.service.ts`). Rotating it invalidates every currently
issued session JWT instantly (signature verification fails), which amounts to a **global forced logout** —
appropriate if the secret itself leaked, but not a targeted tool. There's no dual-secret grace window (unlike
what §28.11 recommends for provider webhook secrets) — plan for "every user has to sign in again" as the
actual cost of this rotation, not a transparent one.

## 8. User notification decisions

No automated breach-notification system exists (correctly — this should be a human decision per incident,
not an automated trigger). Concrete guidance for *this* app:

- **Single-user session/token compromise, contained**: notify the affected user directly (their real email,
  via `MailerService` — see `services/api/src/modules/notifications/mailer.service.ts`) once contained,
  explaining what was revoked and recommending a password change if they haven't already. `identity.service.ts`
  already sends this style of email for password-reset and household-invite flows — reuse that pattern rather
  than building a new notification path under incident pressure.
- **Systemic incident touching encrypted content or the encryption keys themselves** (sections 5-6): this
  crosses into a legal/regulatory notification obligation in most jurisdictions (e.g. GDPR's 72-hour
  authority-notification clock, US state breach-notification laws) — that determination and the actual
  notification copy should involve counsel, not be improvised from this doc. What this doc can state with
  confidence: the asset inventory in `docs/THREAT_MODEL.md` is the starting point for scoping *what* was
  potentially exposed (which tables, which encrypted columns, whether the encryption key itself was part of
  the compromise or the incident was contained to a narrower blast radius).
- **Admin/support account compromise**: `AdminService.revokeAdmin` immediately revokes the admin's own
  sessions (`admin_sessions`, separate from consumer `sessions`) and is audited
  (`admin.recordAccess` → `admin.admin_revoke`). Admin access is metadata-only by design (no document/email
  body or financial detail — see `admin.service.ts`'s doc comment and `docs/SECURITY_CONTROLS.md` V8.1), which
  meaningfully caps what a compromised admin account could have actually seen — worth stating explicitly in
  any user-facing notification about an admin-side incident, since it changes what users actually need to be
  told.

## 9. Known gaps this runbook exposes (tracked here, not hidden)

Writing this document surfaced these as real, currently-true gaps — not fixed here because each is either
out of scope for an application-layer-only fix or a larger piece of work than an incident-response doc should
silently absorb:

- ~~No admin/support endpoint to force-revoke a consumer user's sessions.~~ **Closed**: `POST
  /v1/admin/users/:userId/force-logout` (`AdminService.forceLogoutUser`). (Section 2.)
- ~~`users.status` has a `"suspended"` enum value that nothing in the codebase ever sets or checks.~~
  **Closed**: `AuthGuard` now rejects it (a distinct `ACCOUNT_SUSPENDED` code, both on an already-issued
  session and at sign-in — see `IdentityService.signIn`/`oauthSignIn`), and `AdminService.suspendUser`/
  `unsuspendUser` (`POST /v1/admin/users/:userId/suspend`/`unsuspend`) is the write path that actually
  reaches it, with an admin-console "Suspend account" control in the user-lookup view.
- ~~No provider-side token revocation call in `ConnectorsService.disconnect()` for Google/Microsoft/Dropbox
  OAuth.~~ **Closed for Google/Dropbox** (`ConnectorsService.revokeProviderToken`); Microsoft intentionally
  stays a documented non-call — see its own doc comment on why no such endpoint exists to call. (Section 4.)
- ~~`CredentialVault` has no key-rotation mechanism.~~ **Closed**: same versioned-key,
  decrypt-with-old/encrypt-with-new mechanism `field-encryption.ts` has, plus a real backfill script
  (`rotate-credential-vault-key.ts`) — see section 6.
- **No `SESSION_JWT_SECRET` dual-secret rotation window** — rotating it is an all-at-once global logout, not
  a graceful rollover. (Section 7.) Still open; out of scope for this pass.
- **No backfill script for `FIELD_ENCRYPTION_KEY` rotation** — the mechanism to rotate exists and is tested,
  but the re-encryption sweep across all 50+ encrypted columns has to be written/run manually, not
  `pnpm run`-able today. (Section 5.)
- **No dedicated security-alerting pipeline** (already tracked in `docs/SECURITY_CONTROLS.md` V7.4) — this
  runbook assumes a human notices the incident via a user report, a manual `audit_events` query, or a
  provider notice; there's no automated detection to page anyone.
