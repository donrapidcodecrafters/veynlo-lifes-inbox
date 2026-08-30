import { z } from "zod";

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
  // Was hardcoded to pg's own default (10) with no way to tune it against RDS's real max_connections.
  // The API and worker ECS services set this to different values (see infrastructure/terraform) since
  // they scale independently and have different connection-holding profiles.
  DATABASE_POOL_MAX: z.coerce.number().int().positive().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  SESSION_JWT_SECRET: z.string().default("dev-only-insecure-secret-change-me"),
  CREDENTIAL_ENCRYPTION_KEY: z.string().default("dev-only-32-byte-key-change-me!!"),
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

  // Native mobile sign-in (§Account/security). Unlike the redirect-based web OAuth above, these tokens
  // arrive already signed by Apple/Google from an on-device auth sheet — there's no server-to-server
  // token exchange we control, so verification checks the signature against the provider's published JWKS
  // instead. APPLE_SIGN_IN_CLIENT_ID is the app's bundle identifier (the `aud` claim Sign in with Apple
  // puts in a native app's identity token — NOT a web "Services ID", which is a different audience used
  // only by the browser-redirect flow). GOOGLE_OAUTH_NATIVE_CLIENT_ID is a SEPARATE OAuth client from
  // GOOGLE_OAUTH_CLIENT_ID above — Google registers native and web apps as distinct OAuth clients, and
  // verification requires an exact audience match. Both unset in dev, same "not configured" degradation as
  // every other optional external dependency.
  APPLE_SIGN_IN_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_NATIVE_CLIENT_ID: z.string().optional(),

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
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),

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
  SMTP_SECURE: z.coerce.boolean().default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM_ADDRESS: z.string().default("noreply@veynlo.app"),
});

// Secrets that ship a working dev-only default (so `pnpm dev` never requires a .env file to boot) but
// must never actually run in production with that default still in place — an unset or unrotated secret
// in prod is a silent, severe vulnerability, not a config nicety. Checked in loadEnv() below rather than
// as a Zod .refine() so the error message can name every offending variable at once, not just the first.
const PRODUCTION_REQUIRED_SECRETS = [
  { key: "SESSION_JWT_SECRET" as const, insecureDefault: "dev-only-insecure-secret-change-me", minLength: 32 },
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

export function isConnectorConfigured(provider: "google" | "microsoft"): boolean {
  const env = loadEnv();
  if (provider === "google") return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  return Boolean(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET);
}

export function isInboundEmailConfigured(): boolean {
  const env = loadEnv();
  return Boolean(env.INBOUND_EMAIL_DOMAIN && env.INBOUND_EMAIL_WEBHOOK_SECRET);
}
