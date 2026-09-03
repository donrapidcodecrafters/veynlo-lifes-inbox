import { z } from "zod";

/**
 * `z.coerce.boolean()` runs JS's native `Boolean(value)` on whatever string came out of process.env —
 * and `Boolean("false")` is `true`, because any non-empty string is truthy. That silently turned every
 * `SOME_FLAG=false` in `.env`/`.env.example` into `true` (confirmed live: `SMTP_SECURE=false` from
 * .env.example made the mailer attempt a TLS handshake against Mailhog's plaintext port, failing every
 * send with "wrong version number"). This treats the literal strings "true"/"1" as true and everything
 * else (including "false"/"0"/absent) as false, then falls back to `defaultValue` only when the key is
 * genuinely unset — the behavior every caller here actually wants.
 */
function booleanEnvVar(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value === "boolean") return value;
    return value === "true" || value === "1";
  }, z.boolean());
}

/**
 * All runtime configuration is validated once at boot. A missing/invalid
 * value fails fast instead of surfacing as a confusing error deep in a
 * request path. Secrets are read from process.env (populated by the
 * platform's secrets manager in real deployments) — never hardcoded.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  // Structured (JSON) logging via pino — pretty-printed instead in development. §Observability: this is
  // the "structured logs" half of that ROADMAP line; metrics/tracing remain a separate, larger follow-up
  // that needs a real infra decision (Prometheus/OpenTelemetry backend), not just an app-level change.
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DATABASE_URL: z.string().default("postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  SESSION_JWT_SECRET: z.string().default("dev-only-insecure-secret-change-me"),
  // §36 SYS-001..008 "deep links use signed/internal routes" — see common/signed-deep-link.ts's own doc
  // comment for why this is a separate secret from SESSION_JWT_SECRET rather than reusing it (different
  // blast radius: this one only ever signs a route to open, never authenticates a session).
  DEEPLINK_SIGNING_SECRET: z.string().default("dev-only-deeplink-secret-change-me-too"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().default("dev-only-32-byte-key-change-me!!"),
  // CredentialVault rotation (docs/INCIDENT_RESPONSE.md §6) — same versioned-key-plus-_PREVIOUS shape as
  // FIELD_ENCRYPTION_KEY_VERSION/_PREVIOUS/_PREVIOUS_VERSION below, kept as its own separate variable set
  // (not shared with FIELD_ENCRYPTION_KEY's) so the two key rings — OAuth credentials vs. everything else
  // §SEC-ROW covers — can be rotated on independent schedules, same reasoning as the two root keys already
  // being separate.
  CREDENTIAL_ENCRYPTION_KEY_VERSION: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION: z.string().optional(),
  // Envelope-encrypts sensitive row/field content at rest (§SEC-ROW) — separate key from
  // CREDENTIAL_ENCRYPTION_KEY (which only covers OAuth tokens) so the two data classes can be rotated
  // independently. See packages/db/src/crypto/field-encryption.ts for what this does and doesn't cover.
  FIELD_ENCRYPTION_KEY: z.string().default("dev-only-field-encryption-key-change-me"),
  FIELD_ENCRYPTION_KEY_VERSION: z.string().optional(),
  FIELD_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION: z.string().optional(),

  WEB_APP_URL: z.string().default("http://localhost:3000"),
  ADMIN_APP_URL: z.string().default("http://localhost:3100"),
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),

  // Connector OAuth — unset in dev; connections show a clear "not configured" state rather than pretending to work.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_ID: z.string().optional(),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().optional(),
  // Dropbox needs its own separate app registration (a Dropbox App Console app, not reusable across
  // providers the way one Google/Microsoft OAuth app covers several connectors) — unset in dev, same
  // "not configured" degradation as every other connector above.
  DROPBOX_CLIENT_ID: z.string().optional(),
  DROPBOX_CLIENT_SECRET: z.string().optional(),
  // Financial aggregator (§52.2 Phase 2, feasibility class D) — Plaid, a real paid partner account, not a
  // free OAuth app like Google/Microsoft. Unset in dev, same "not configured" degradation as every other
  // connector above; PLAID_ENV picks which of Plaid's own environments (sandbox/production) to call.
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(["sandbox", "production"]).default("sandbox"),

  // Sign in with Apple — a Services ID (the OAuth "client_id"), the Team ID and Key ID from an Apple
  // Developer account, and the .p8 private key downloaded once when that Sign in with Apple key is
  // created (PEM text, e.g. via `cat AuthKey_XXXX.p8` — not a path, matching how every other secret here
  // is passed as a value). All four are needed together to mint the ES256-signed JWT Apple requires as
  // the OAuth "client_secret"; unset in dev, same "not configured" degradation as Google/Microsoft.
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  APPLE_PRIVATE_KEY: z.string().optional(),

  // AI
  ANTHROPIC_API_KEY: z.string().optional(),

  // Malware scanning for document uploads (§SEC — documents.service.ts). Unset in dev by default: uploads
  // still work, just unscanned, same "not configured" degradation as the Google/Microsoft connectors.
  CLAMD_HOST: z.string().optional(),
  CLAMD_PORT: z.coerce.number().int().default(3310),

  // Object storage (S3-compatible; MinIO locally)
  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().default("veynlo"),
  S3_SECRET_ACCESS_KEY: z.string().default("veynlo_dev_password"),
  S3_BUCKET: z.string().default("veynlo-documents"),
  S3_FORCE_PATH_STYLE: booleanEnvVar(true),

  // Billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Real Stripe Price object IDs for the two sold plans (Core UX MVP row "Billing" — a plan/checkout
  // surface needs to know what to actually charge). Unset in dev, same "not configured" degradation as
  // every other optional external dependency — GET /v1/billing/plans returns an empty list rather than
  // pretending a subscribe button works with no real price behind it.
  STRIPE_PRICE_PLUS_MONTHLY: z.string().optional(),
  STRIPE_PRICE_FAMILY_MONTHLY: z.string().optional(),
  // Annual variants are independently optional — a deployment can sell monthly-only, annual-only, or
  // both; GET /v1/billing/plans reflects exactly the (plan, interval) combinations that actually have a
  // configured price, same "not configured" degradation as the monthly prices above.
  STRIPE_PRICE_PLUS_ANNUAL: z.string().optional(),
  STRIPE_PRICE_FAMILY_ANNUAL: z.string().optional(),
  // RevenueCat normalizes Apple/Google/web subscription entitlements (§SEC-BILLING). Unset in dev —
  // the webhook route returns a clear "not configured" state rather than pretending to work, same as
  // the Google/Microsoft connectors above. RevenueCat webhook auth is a static shared header value it
  // echoes back on every call (configured in its dashboard), not an HMAC signature like Stripe's.
  REVENUECAT_WEBHOOK_AUTH_HEADER: z.string().optional(),

  // CAP-005 "forward-to-Life-Inbox address" (§12.1/§52.1) — a real inbound-email provider (Postmark/
  // Mailgun/SendGrid inbound parse) needs its own domain (SPF/DKIM/DMARC verified) and a webhook shared
  // secret; unset in dev, same "not configured" degradation as every other optional external dependency —
  // the alias UI and the inbound webhook both refuse to pretend this works with no real provider behind it.
  INBOUND_EMAIL_DOMAIN: z.string().optional(),
  INBOUND_EMAIL_WEBHOOK_SECRET: z.string().optional(),

  // Outbound email (notification delivery + daily/weekly briefs). Defaults target the local Mailhog
  // container so email genuinely sends in dev — visible at http://localhost:8025 — without any real
  // provider credentials. Point these at a real SMTP/API provider in staging/production.
  SMTP_HOST: z.string().default("localhost"),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: booleanEnvVar(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().default("noreply@veynlo.app"),

  // "Pre-launch private testing distribution" (docs/ROADMAP.md) — gates POST /v1/auth/sign-up behind an
  // admin-issued, single-use invite code (signup_invites table) when on. Defaults OFF so existing dev/test
  // sign-up behavior is completely unaffected unless a deployment explicitly opts in.
  SIGNUP_REQUIRES_INVITE: booleanEnvVar(false),
});

// Secrets that ship a working dev-only default (so `pnpm dev` never requires a .env file to boot) but
// must never actually run in production with that default still in place — an unset or unrotated secret
// in prod is a silent, severe vulnerability, not a config nicety. Checked in loadEnv() below rather than
// as a Zod .refine() so the error message can name every offending variable at once, not just the first.
const PRODUCTION_REQUIRED_SECRETS = [
  { key: "SESSION_JWT_SECRET" as const, insecureDefault: "dev-only-insecure-secret-change-me", minLength: 32 },
  { key: "DEEPLINK_SIGNING_SECRET" as const, insecureDefault: "dev-only-deeplink-secret-change-me-too", minLength: 32 },
  { key: "CREDENTIAL_ENCRYPTION_KEY" as const, insecureDefault: "dev-only-32-byte-key-change-me!!", minLength: 32 },
  { key: "FIELD_ENCRYPTION_KEY" as const, insecureDefault: "dev-only-field-encryption-key-change-me", minLength: 32 },
];

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }

  if (parsed.data.NODE_ENV === "production") {
    const problems = PRODUCTION_REQUIRED_SECRETS.filter(
      ({ key, insecureDefault, minLength }) => parsed.data[key] === insecureDefault || parsed.data[key].length < minLength,
    ).map(({ key }) => key);
    if (problems.length > 0) {
      throw new Error(
        `Refusing to start in production with an insecure or missing secret: ${problems.join(", ")}. ` +
          "Generate real random values (e.g. `openssl rand -base64 32`) for each and set them via your secrets manager.",
      );
    }
  }

  cached = parsed.data;
  return cached;
}

export function isRevenueCatConfigured(): boolean {
  return Boolean(loadEnv().REVENUECAT_WEBHOOK_AUTH_HEADER);
}

export function isConnectorConfigured(provider: "google" | "microsoft" | "dropbox" | "plaid"): boolean {
  const env = loadEnv();
  if (provider === "google") return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  if (provider === "dropbox") return Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET);
  if (provider === "plaid") return Boolean(env.PLAID_CLIENT_ID && env.PLAID_SECRET);
  return Boolean(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET);
}

export function isAppleSignInConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY);
}

export function isInboundEmailConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.INBOUND_EMAIL_DOMAIN && env.INBOUND_EMAIL_WEBHOOK_SECRET);
}
