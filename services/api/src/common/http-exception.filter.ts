import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { randomUUID } from "node:crypto";

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
      response.status(status).send({
        code: (structured.code as string) ?? HttpStatus[status] ?? "ERROR",
        message: (structured.message as string) ?? "Request failed.",
        fieldErrors: structured.fieldErrors ?? undefined,
        retryable: status >= 500,
        traceId,
      });
      return;
    }

    // eslint-disable-next-line no-console
    console.error(`[unhandled:${traceId}]`, exception);
    response.status(500).send({
      code: "INTERNAL_ERROR",
      message: "Something went wrong on our end. Please try again.",
      retryable: true,
      traceId,
    });
  }
}
