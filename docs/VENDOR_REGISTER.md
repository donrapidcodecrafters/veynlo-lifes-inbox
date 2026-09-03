# Vendor / subprocessor register

Blueprint §28.20: "Maintain a vendor/subprocessor register with data accessed, purpose, regions,
retention/training behavior, breach notification terms, security contact, DPA, owner, and annual review
date."

This lists every third-party service this codebase currently sends user data to or depends on for a
security-relevant function, based on real integration code (not aspirational — a vendor isn't listed here
because the blueprint mentions it, only because this repo actually calls it). Several columns
(retention/training behavior, breach notification terms, DPA, security contact) require reading each
vendor's actual current terms of service/DPA — a legal/compliance task, not something to be inferred from
code. Those columns are marked "verify before launch" rather than filled with a guess.

**Owner** for every row: single-developer repository today (see CODEOWNERS). **Review cadence**: annual,
or immediately after any material change to what data a vendor receives.

| Vendor | Data accessed | Purpose | Integration point | Region(s) | Retention/training | Breach notification | DPA | Security contact | Status |
|---|---|---|---|---|---|---|---|---|---|
| Anthropic | Email/document/calendar text sent for extraction; Ask Veynlo query context (all owner-scoped, never cross-tenant) | AI-assisted structured extraction, OCR, Ask Veynlo | `services/api/src/modules/intelligence/anthropic-extraction.service.ts` | Verify before launch | Verify before launch — confirm training-opt-out setting matches Veynlo's privacy promise (§28.12) | Verify before launch | Verify before launch | Verify before launch | **Not yet contracted** — `ANTHROPIC_API_KEY` unset; app runs deterministic-parser-only fallback |
| Google (Gmail API, Google Calendar API, Google OAuth) | Email/calendar content and metadata via user-granted OAuth scope; Google account email for sign-in | Gmail/Google Calendar connectors, "Sign in with Google" | `services/api/src/modules/connectors/gmail.adapter.ts`, `google-calendar.adapter.ts`, `identity.service.ts` | Google's standard multi-region | Verify Google's API Services User Data Policy terms directly | Verify before launch | Google's standard Cloud/API terms — verify which apply | Verify before launch | **Not yet configured** — `GOOGLE_OAUTH_CLIENT_ID/SECRET` unset. **Also blocked on the restricted-scope security assessment** (blueprint §28.12: Gmail-scope apps routing data through Veynlo servers require an annual App Defense Alliance/CASA assessment) — plan this lead time before requesting production Gmail scopes |
| Microsoft (Graph API, Microsoft OAuth) | Email/calendar content and metadata via user-granted OAuth scope; Microsoft account email for sign-in | Outlook/Microsoft 365 + Microsoft Calendar connectors, "Sign in with Microsoft" | `outlook.adapter.ts`, `microsoft-calendar.adapter.ts`, `identity.service.ts` | Microsoft's standard multi-region | Verify Microsoft Graph terms of use directly | Verify before launch | Microsoft's standard terms — verify which apply | Verify before launch | **Configured** — real `MICROSOFT_OAUTH_CLIENT_ID/SECRET` present in this environment's `.env` |
| Stripe | Payment method details (never touch Veynlo's own servers — Stripe-hosted checkout), email, subscription metadata | Web subscription billing | `services/api/src/modules/billing/stripe-billing-provider.service.ts` | US-based, PCI-DSS Level 1 | Stripe's standard terms — verify current DPA | Verify before launch | Stripe DPA — standard, verify execution | Verify before launch | **Not yet contracted** — `STRIPE_SECRET_KEY` unset |
| RevenueCat | Subscription/entitlement state normalized across Apple/Google/Stripe; no payment card data | Cross-platform entitlement normalization | `services/api/src/modules/billing/revenuecat.service.ts` | Verify before launch | Verify before launch | Verify before launch | Verify before launch | Verify before launch | **Not yet contracted** — `REVENUECAT_WEBHOOK_AUTH_HEADER` unset |
| Expo (push notification service) | Device push token, notification title/body (no user content beyond the notification text itself) | Mobile push delivery | `services/api/src/modules/notifications/push.service.ts` | Verify before launch | Verify Expo's push-notification-service terms | Verify before launch | Verify before launch | Verify before launch | Code is live (no credential required for classic push sends); needs an EAS project ID to fully activate — see the credentials list already given to the user |
| Apple (APNs, App Store Connect, Sign in with Apple — planned) | Device push token (via Expo → APNs); future: subscription receipts, Sign-in identity token | Native iOS push; planned App Store subscriptions and Apple sign-in | Not yet built (Apple Sign-In); push is Expo-mediated | Apple's infrastructure | Apple's standard developer terms | Verify before launch | Apple Developer Program agreement | Verify before launch | Developer Program membership active; App Store Connect products not yet created |
| SMTP provider (currently Mailhog in dev; unconfigured for production) | Recipient email address, notification/transactional email content | Outbound transactional email (password reset, household invites, digests) | `services/api/src/modules/notifications/mailer.service.ts` | Depends on chosen provider | Depends on chosen provider | Verify before launch | Depends on chosen provider | Verify before launch | **Dev-only today** — `SMTP_HOST` defaults to local Mailhog; no production provider selected yet |
| Inbound email provider (Postmark/Mailgun/SendGrid — none selected yet) | Full email body/subject/sender for mail forwarded to a user's Life Inbox alias | "Forward to your Life Inbox" capture path | `services/api/src/modules/ingestion/inbound-email.controller.ts` | Depends on chosen provider | Depends on chosen provider | Verify before launch | Depends on chosen provider | Verify before launch | **Not yet selected** — `INBOUND_EMAIL_DOMAIN`/`INBOUND_EMAIL_WEBHOOK_SECRET` both unset |
| ClamAV (self-hosted, not a third party) | Uploaded file bytes, scanned in-memory, not retained by ClamAV itself | Malware scanning on document upload | `services/api/src/modules/documents/malware-scanner.service.ts`, `infrastructure/docker/docker-compose.yml` | Self-hosted (no data leaves Veynlo's own infrastructure) | N/A — self-hosted | N/A | N/A | N/A | Live in dev via Docker Compose; production deployment is an infra decision |
| AWS S3 (or MinIO locally) | Document originals, OCR derivatives, data-export manifests | Private object storage | `services/api/src/modules/documents/storage.service.ts` | Configurable at deploy time | Standard AWS terms once a real account exists | Verify before launch | AWS DPA (standard) | Verify before launch | **Not yet on real AWS** — MinIO locally, per `docs/DECISIONS.md` |

## Vendors named in the blueprint but not yet integrated (no data flow to review yet)

Plaid (financial connectors — Phase 2, no code exists), OpenSearch, AWS Cognito, AWS KMS, Sentry (no SDK
installed), any cloud OCR/document-intelligence vendor beyond Anthropic. These will each need a row above
before the first real integration ships, not retroactively.

## Next steps before a real launch

1. For every row marked "verify before launch," pull the vendor's actual current DPA/ToS and fill in the
   real retention, training-data, and breach-notification terms — this needs a human reading the current
   legal terms, not an inference from code.
2. Confirm which vendors require a signed DPA before receiving any real user data (this is a legal
   requirement in many jurisdictions once real personal data — not synthetic test data — flows to them).
3. Set a recurring annual review reminder per vendor once contracted.
