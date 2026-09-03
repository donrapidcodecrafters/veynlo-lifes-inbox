import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { randomUUID } from "node:crypto";
import { sanitizeErrorForLog } from "./safe-error-log";

/**
 * §42.1 — every API error carries a machine code, a user-safe message,
 * retryability, and a trace/reference ID. Provider/internal errors are
 * mapped here and never leak raw stack traces or secrets to clients.
 */
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
      const isThrottled = exception instanceof ThrottlerException;
      response.status(status).send({
        code: isThrottled ? "TOO_MANY_REQUESTS" : ((structured.code as string) ?? HttpStatus[status] ?? "ERROR"),
        message: isThrottled ? "You're doing that too much. Please wait a bit and try again." : ((structured.message as string) ?? "Request failed."),
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
