import "./config/load-env-file"; // must be the first import — see its own doc comment for why
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

async function bootstrap() {
  const env = loadEnv();
  const adapter = new FastifyAdapter({ bodyLimit: 30 * 1024 * 1024 });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Stripe (and, identically, Plaid's) webhook signature verification needs the exact raw request bytes —
  // Plaid's `request_body_sha256` claim (see webhook-verification.ts's verifyPlaidWebhook) hashes the raw
  // body Plaid actually sent, which even a byte-identical JSON.stringify(JSON.parse(body)) round trip could
  // subtly change (key order, whitespace). Rather than replacing Nest's own JSON content-type parser
  // (registering a second one throws FST_ERR_CTP_ALREADY_PRESENT), a preParsing hook — scoped to only these
  // webhook routes — tees the incoming stream: it buffers every chunk for `req.rawBody` while replaying the
  // same chunks through a pass-through stream so the normal JSON parser downstream is unaffected. Every
  // other route (including multipart uploads) is left untouched.
  const RAW_BODY_ROUTES = new Set(["/v1/billing/webhook", "/v1/webhooks/plaid"]);
  const { PassThrough } = await import("node:stream");
  adapter.getInstance().addHook("preParsing", async (req, _reply, payload) => {
    if (!RAW_BODY_ROUTES.has(req.url)) return payload;
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
  // §CORS — `@fastify/cors`'s own default `methods` list is `GET,HEAD,POST` only (older `cors`/Express
  // middleware defaults to a broader set including PUT/DELETE, which this silently is NOT that). Every
  // `PUT` request in this app (e.g. `PUT /v1/notification-preferences`) was being blocked by the browser's
  // own CORS preflight before ever reaching the server — found live via real browser testing, since a
  // same-process curl/Postman request never triggers a CORS preflight and so could never have caught this.
  // DELETE added when the Phase 2 property/vehicle-profile UI became this app's first real caller of a
  // DELETE route from a browser — same exact gap, caught before shipping this time by remembering the PUT
  // lesson rather than by a second live failure.
  // PATCH added the same way, found live during a CAL-001/CAL-002/CAL-003/TASK-003 integration audit:
  // `PATCH /v1/connectors/:id/write-back` (the Connections page's write-back toggle) was the first real
  // browser-originated PATCH call, and it silently failed every click with a CORS preflight rejection
  // ("Method PATCH is not allowed by Access-Control-Allow-Methods") — the toggle appeared to do nothing,
  // never reaching ConnectorsService.setWriteBack at all. Also unblocks every other existing PATCH route
  // that happened to have no live browser caller yet: household update/member update
  // (household.controller.ts) and the emergency-binder household settings update
  // (emergency-binder.controller.ts).
  app.enableCors({ origin: corsOrigin, credentials: true, methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] });
  app.useGlobalFilters(new GlobalExceptionFilter());

  await app.listen(env.PORT, "0.0.0.0");
  app.get(Logger).log(`Veynlo API listening on port ${env.PORT} (${env.NODE_ENV})`);
}

bootstrap();
