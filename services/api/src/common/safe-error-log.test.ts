import { describe, expect, it } from "vitest";
import { z } from "zod";
import { maskEmail, sanitizeErrorForLog, summarizeZodError } from "./safe-error-log";

/**
 * §28 "No raw user emails/documents/OAuth tokens in normal application logs" — this session's log-leak
 * sweep found the global exception filter logging caught exceptions wholesale
 * (`console.error(traceId, exception)`), which prints every enumerable own-property Node's util.inspect
 * finds, not just name/message/stack. A real-world HTTP client error (axios/undici) commonly carries a
 * `.response`/`.config` property with the outbound request's Authorization header and body — exactly the
 * OAuth-token/document-content leak this control exists to prevent. These tests pin down that
 * `sanitizeErrorForLog` actually drops that data rather than merely intending to.
 */
describe("sanitizeErrorForLog", () => {
  it("keeps only name/message/stack from a plain Error", () => {
    const err = new Error("boom");
    const result = sanitizeErrorForLog(err);
    expect(result.name).toBe("Error");
    expect(result.message).toBe("boom");
    expect(result.stack).toContain("Error: boom");
  });

  it("drops extra properties an axios-shaped error carries (the real leak vector)", () => {
    // Simulates an AxiosError: a real Error subclass with a `.response.data`/`.config.headers` payload
    // that can contain the outbound OAuth Authorization header and/or the request body (which, for a
    // connector call, can be the user's own email/document content being sent to a provider).
    const axiosLikeError = new Error("Request failed with status code 401") as Error & {
      response: { data: { userEmail: string; documentText: string } };
      config: { headers: { Authorization: string } };
    };
    axiosLikeError.response = { data: { userEmail: "victim@example.com", documentText: "sensitive receipt contents" } };
    axiosLikeError.config = { headers: { Authorization: "Bearer super-secret-oauth-token" } };

    const result = sanitizeErrorForLog(axiosLikeError);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("sensitive receipt contents");
    expect(serialized).not.toContain("super-secret-oauth-token");
    expect(Object.keys(result).sort()).toEqual(["message", "name", "stack"]);
  });

  it("never throws and never echoes a raw non-Error thrown value verbatim", () => {
    // A string/object could itself be attacker- or provider-controlled (e.g. `throw someProviderPayload`).
    const stringResult = sanitizeErrorForLog("raw thrown string with an email like a@b.com");
    expect(stringResult.message).not.toContain("a@b.com");

    const objectResult = sanitizeErrorForLog({ email: "leak@example.com", token: "abc123" });
    const serialized = JSON.stringify(objectResult);
    expect(serialized).not.toContain("leak@example.com");
    expect(serialized).not.toContain("abc123");
  });
});

describe("summarizeZodError", () => {
  it("reports path and issue code without echoing the offending value", () => {
    const schema = z.object({ category: z.enum(["receipt", "warranty"]) });
    const parsed = schema.safeParse({ category: "medical-diagnosis-lyme-disease" });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("expected failure");

    const summary = summarizeZodError(parsed.error);
    expect(summary).toContain("category");
    expect(summary).not.toContain("medical-diagnosis-lyme-disease");
  });
});

describe("maskEmail", () => {
  it("keeps only the first character of the local part and the full domain", () => {
    expect(maskEmail("john.doe@example.com")).toBe("j***@example.com");
  });

  it("degrades safely for a malformed address", () => {
    expect(maskEmail("not-an-email")).toBe("***");
  });
});
