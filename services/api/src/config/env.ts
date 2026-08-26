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

  WEB_APP_URL: z.string().default("http://localhost:3000"),
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

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  cached = parsed.data;
  return cached;
}

export function isConnectorConfigured(provider: "google" | "microsoft"): boolean {
  const env = loadEnv();
  if (provider === "google") return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET);
  return Boolean(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET);
}
