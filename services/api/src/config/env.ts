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
  DATABASE_URL: z.string().default("postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo"),
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

  // AI
  ANTHROPIC_API_KEY: z.string().optional(),

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

export function isConnectorConfigured(provider: "google" | "microsoft"): boolean {
  const env = loadEnv();
  if (provider === "google") return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  return Boolean(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET);
}
