import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyHelmet from "@fastify/helmet";
import { AppModule } from "./app.module";
import { loadEnv } from "./config/env";
import { GlobalExceptionFilter } from "./common/http-exception.filter";
import { registerMetricsHook } from "./metrics/metrics.hook";

async function bootstrap() {
  const env = loadEnv();
  const adapter = new FastifyAdapter({ bodyLimit: 30 * 1024 * 1024 });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Stripe webhook signature verification needs the exact raw request bytes. Rather than replacing Nest's
  // own JSON content-type parser (registering a second one throws FST_ERR_CTP_ALREADY_PRESENT), a
  // preParsing hook — scoped to only the webhook route — tees the incoming stream: it buffers every chunk
  // for `req.rawBody` while replaying the same chunks through a pass-through stream so the normal JSON
  // parser downstream is unaffected. Every other route (including multipart uploads) is left untouched.
  const { PassThrough } = await import("node:stream");
  adapter.getInstance().addHook("preParsing", async (req, _reply, payload) => {
    if (req.url !== "/v1/billing/webhook") return payload;
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();
    payload.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      passthrough.write(chunk);
    });
    payload.on("end", () => {
      (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.concat(chunks);
      passthrough.end();
    });
    payload.on("error", (err) => passthrough.destroy(err));
    return passthrough;
  });

  // `as any`: @fastify/cookie and @fastify/multipart ship their own bundled `fastify` type declarations,
  // which structurally diverge from @nestjs/platform-fastify's — a well-known cross-package typing friction
  // in the Fastify ecosystem. Runtime behavior (register() wiring the plugin) is unaffected.
  await app.register(fastifyCookie as any);
  await app.register(fastifyMultipart as any, { limits: { fileSize: 25 * 1024 * 1024 } });
  // Baseline security headers (HSTS, X-Content-Type-Options, X-Frame-Options, etc.) — a pentest-checklist
  // basic that was simply missing. CSP is disabled: this is a pure JSON API with no HTML views of its own
  // to protect, and a default CSP would just add noise to every response without defending anything real.
  await app.register(fastifyHelmet as any, { contentSecurityPolicy: false });

  // Native (iOS/Android) requests aren't subject to CORS at all — it's a browser-only mechanism, enforced
  // here only for the two real browser-based clients (web, admin) plus, in development, any localhost origin
  // so the Expo web preview (a real browser context, unlike the native app it mirrors) can hit the API too.
  const corsOrigin =
    env.NODE_ENV === "production" ? [env.WEB_APP_URL, env.ADMIN_APP_URL] : [env.WEB_APP_URL, env.ADMIN_APP_URL, /^http:\/\/localhost:\d+$/];
  // Explicit methods list: @fastify/cors's own default (via NestJS's enableCors) only allows
  // GET/HEAD/POST — every PUT/PATCH/DELETE route in this API (notification-preferences, onboarding,
  // sessions, disconnect, etc.) was silently failing CORS preflight from a real browser despite
  // working fine over curl (same-origin tooling never triggers a preflight at all).
  app.enableCors({ origin: corsOrigin, credentials: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  app.useGlobalFilters(new GlobalExceptionFilter());
  registerMetricsHook(app);

  await app.listen(env.PORT, "0.0.0.0");
  app.get(Logger).log(`Veynlo API listening on port ${env.PORT} (${env.NODE_ENV})`);
}

bootstrap();
