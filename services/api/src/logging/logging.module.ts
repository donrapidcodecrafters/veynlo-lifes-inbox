import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { loadEnv } from "../config/env";

/**
 * §Observability — replaces Nest's default console logger with structured JSON (pino), which is what
 * every real log aggregator (CloudWatch, Datadog, etc.) actually wants; pretty-printed only in
 * development for human readability. `app.useLogger(app.get(Logger))` in main.ts/worker-main.ts is what
 * makes this apply globally — every existing `new Logger(ClassName.name)` call site in the codebase
 * (services/notifications/billing/ingestion/etc.) routes through this with zero changes, since Nest's
 * built-in Logger delegates to whatever was registered via useLogger().
 */
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: loadEnv().LOG_LEVEL,
        transport: loadEnv().NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true, singleLine: true } },
        // Never let a session cookie, bearer token, or password land in a log line — the request/response
        // objects pino-http auto-logs would otherwise include the raw Authorization/Cookie headers. No
        // custom request serializer is registered (checked: pino-http's default request serializer does
        // NOT include req.body at all), so these req.body.* paths are defense-in-depth for if one is ever
        // added later, not currently live redaction of a real leak — §28.11 "Error reporting/tracing/
        // logging SDKs must apply server-side redaction for Authorization, Cookie, Set-Cookie, tokens,
        // document text, financial details, and other sensitive fields" calls for exactly this posture.
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            'res.headers["set-cookie"]',
            "req.body.password",
            "req.body.newPassword",
            "req.body.refreshToken",
            "req.body.token",
            "req.body.accessToken",
          ],
          censor: "[redacted]",
        },
      },
    }),
  ],
  exports: [LoggerModule],
})
export class LoggingModule {}
