import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { randomUUID } from "node:crypto";
import { sanitizeErrorForLog } from "./safe-error-log";
import { redactUrlSecrets } from "../logging/redact-url-secrets";

/**
 * §42.1 — every API error carries a machine code, a user-safe message,
 * retryability, and a trace/reference ID. Provider/internal errors are
 * mapped here and never leak raw stack traces or secrets to clients.
 */
/** The one user-facing sentence every rate limit returns, regardless of which layer produced it. */
const RATE_LIMITED_MESSAGE = "You're doing that too much. Please wait a bit and try again.";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const traceId = randomUUID();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const structured =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)
          : { message: body };
      // @nestjs/throttler's ThrottlerException carries no `code`/`message` of its own — its getResponse()
      // body's `message` is the library's default `"ThrottlerException: Too Many Requests"`, which is the
      // exception's class name plus its constructor message, not a user-safe string. Confirmed live: every
      // throttled endpoint (sign-in, sign-up, data-export, inbound-email, ...) surfaced that raw string
      // verbatim in the UI (e.g. apps/mobile's data-export screen just renders `err.message` as-is),
      // violating the "never leak raw ... internals" contract this filter otherwise upholds.
      // Every 429 gets the SAME code and the SAME message here, whichever layer produced it — the per-IP
      // ThrottlerGuard or one of IdentityService's per-account counters. That is a security property, not
      // cosmetics: a client that can tell the two apart learns which control it tripped, and therefore
      // whether the account it is guessing at exists. It held before only because the same sentence had
      // been typed into two files, which a test caught by using a slightly different one. Now it holds by
      // construction, at the single place every error leaves this API.
      const isRateLimited = status === HttpStatus.TOO_MANY_REQUESTS;
      const isThrottled = exception instanceof ThrottlerException;
      const code = isRateLimited ? "TOO_MANY_REQUESTS" : ((structured.code as string) ?? HttpStatus[status] ?? "ERROR");

      // §42.1 asks every error to carry "a trace/reference ID". This one was generated, returned to the
      // client on EVERY response including 4xx, and written to a log only for unhandled 500s — so a user
      // or a support agent holding a reference from a 403 or a 429 had nothing to look it up in. A
      // reference that references nothing is worse than none, because it implies someone can trace it.
      //
      // Deliberately narrow about what goes in the line. No body (it can hold a password), no headers (a
      // cookie or bearer token), and the URL passes through the same redactor the request logger uses, so
      // a share/day-pass/legacy-release token cannot arrive here by the back door either.
      //
      // `limiter` distinguishes the two rate limits, which are otherwise indistinguishable: the per-IP
      // ThrottlerGuard and IdentityService's per-account counters return the same code and the same
      // user-facing message on purpose (a distinct message would leak which control fired), and that left
      // an operator seeing a 429 with no way to tell them apart.
      const request = ctx.getRequest();
      const limiter = isThrottled ? " limiter=per-ip" : code === "TOO_MANY_REQUESTS" ? " limiter=per-account" : "";
      console.warn(
        `[http:${traceId}] ${status} ${code} ${String(request?.method ?? "?")} ${String(redactUrlSecrets(request?.url) ?? "?")}${limiter}`,
      );

      response.status(status).send({
        code,
        message: isRateLimited ? RATE_LIMITED_MESSAGE : ((structured.message as string) ?? "Request failed."),
        fieldErrors: structured.fieldErrors ?? undefined,
        retryable: status >= 500,
        traceId,
      });
      return;
    }

    // §28 "No raw user emails/documents/OAuth tokens in normal application logs" — logging the raw
    // exception object here (as this used to) prints every enumerable own-property Node's util.inspect
    // finds, not just name/message/stack; a real-world HTTP client error (axios/undici) commonly carries
    // `.config`/`.request`/`.response` with outbound Authorization headers and request/response bodies.
    // This filter is the one place EVERY unhandled exception in the app funnels through, so it's the
    // highest-leverage single fix for this class of leak. See safe-error-log.ts for the full rationale.
    console.error(`[unhandled:${traceId}]`, sanitizeErrorForLog(exception));
    response.status(500).send({
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our end. Please try again.",
      retryable: true,
      traceId,
    });
  }
}
