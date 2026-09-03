import type { ZodError } from "zod";

/**
 * §28 "No raw user emails/documents/OAuth tokens in normal application logs" — a bare
 * `console.error(exception)` / `logger.error(err)` on a caught error object is a real leak vector: many
 * error types (axios/undici HTTP client errors especially) carry extra enumerable own-properties beyond
 * `name`/`message`/`stack` — e.g. `.config`/`.request`/`.response` with the outbound request's headers
 * (including `Authorization: Bearer <oauth-token>`) and body, or the third party's raw response body
 * (which can itself contain the user's email/document content that was being sent for processing). Node's
 * default `console.error`/util.inspect formatting of an Error prints every enumerable own property, not
 * just the three safe ones — so logging the raw object silently republishes whatever a thrown error happens
 * to be carrying, unredacted, and never runs through pino's `redact` config since it bypasses the logger
 * entirely (or, even through the pino logger, `redact` only strips a fixed path list, not
 * `err.response.data` interpolated dynamically into every possible caught error's shape).
 *
 * Reduces any thrown value to exactly the three fields safe to persist in a log: type name, message,
 * stack. Never include a custom `.response`/`.config`/`.body`/`.data`/`.cause` property — those are where
 * request/response payloads (and therefore tokens/PII) actually live on real-world HTTP client errors.
 */
export function sanitizeErrorForLog(exception: unknown): { name: string; message: string; stack?: string } {
  if (exception instanceof Error) {
    return { name: exception.name, message: exception.message, stack: exception.stack };
  }
  // A thrown non-Error value (a bare string/number/object) can be attacker- or provider-controlled content
  // (e.g. a third-party SDK that `throw`s its raw response body) — never echo it verbatim, even a
  // seemingly-harmless string, since there's no way to know it isn't someone's email/document text.
  return { name: "NonError", message: "A non-Error value was thrown (details omitted from logs)." };
}

/**
 * Summarizes a ZodError for logging without the `received`/`expected` values some issue codes
 * (`invalid_enum_value`, `invalid_literal`, `invalid_union_discriminator`, ...) embed directly into
 * `error.message`/`error.issues[].message` — those values can be the actual data that failed validation
 * (e.g. AI-extracted document/email content, or a webhook payload field), not just its shape. Path + issue
 * code is enough to diagnose a schema mismatch without echoing the offending value into application logs.
 */
export function summarizeZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.code}`).join("; ");
}

/**
 * Masks an email address for a log line that has no other identifier to reference (most call sites should
 * prefer logging a durable userId/resourceId instead — this exists for the rare shared low-level sender
 * that only receives a raw address). Keeps the first character and the domain (enough to spot "everything
 * to @some-provider.com is bouncing") while dropping the rest of the local part.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}
