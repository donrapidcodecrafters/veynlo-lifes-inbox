import { describe, expect, it, vi, afterEach } from "vitest";
import { ForbiddenException, HttpException, HttpStatus } from "@nestjs/common";
import { ThrottlerException } from "@nestjs/throttler";
import { GlobalExceptionFilter } from "./http-exception.filter";

/**
 * §42.1 — "every API error carries a machine code, a user-safe message, retryability, and a trace/reference
 * ID." The ID was generated and returned on every response, and written to a log only for unhandled 500s.
 * So a user or support agent holding a reference from a 403 or a 429 had nothing to look it up in — a
 * reference that references nothing, which is worse than none because it implies someone can trace it.
 */
function makeHost(request: { method?: string; url?: string }) {
  const sent: Array<Record<string, unknown>> = [];
  const response = {
    status() {
      return response;
    },
    send(body: Record<string, unknown>) {
      sent.push(body);
      return response;
    },
  };
  return {
    sent,
    host: {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as never,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("GlobalExceptionFilter — traceability", () => {
  it("logs the same traceId it returns, so a client's reference can be looked up", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, sent } = makeHost({ method: "POST", url: "/v1/purchases" });
    new GlobalExceptionFilter().catch(new ForbiddenException({ code: "NOT_OWNER", message: "Not yours." }), host);

    const returned = sent[0]!.traceId as string;
    expect(returned).toBeTruthy();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(returned);
  });

  it("records the status, code, method and path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host } = makeHost({ method: "POST", url: "/v1/purchases" });
    new GlobalExceptionFilter().catch(new ForbiddenException({ code: "NOT_OWNER", message: "Not yours." }), host);

    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain("403");
    expect(line).toContain("NOT_OWNER");
    expect(line).toContain("POST");
    expect(line).toContain("/v1/purchases");
  });

  it("never writes a share token into the line, even though it writes the path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host } = makeHost({ method: "POST", url: "/v1/share/a-real-looking-secret-token/access" });
    new GlobalExceptionFilter().catch(new ForbiddenException({ code: "SHARE_LINK_NOT_FOUND", message: "Not found." }), host);

    const line = String(warn.mock.calls[0]![0]);
    expect(line).not.toContain("a-real-looking-secret-token");
    expect(line).toContain("[redacted]");
  });

  it("distinguishes the two rate limiters, which are identical to the client on purpose", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const perIp = makeHost({ method: "POST", url: "/v1/auth/sign-in" });
    new GlobalExceptionFilter().catch(new ThrottlerException(), perIp.host);
    expect(String(warn.mock.calls[0]![0])).toContain("limiter=per-ip");

    const perAccount = makeHost({ method: "POST", url: "/v1/auth/sign-in" });
    new GlobalExceptionFilter().catch(
      new HttpException({ code: "TOO_MANY_REQUESTS", message: "You're doing that too much." }, HttpStatus.TOO_MANY_REQUESTS),
      perAccount.host,
    );
    expect(String(warn.mock.calls[1]![0])).toContain("limiter=per-account");

    // ...while the client still sees the same code and message from both, which is the point.
    expect(perIp.sent[0]!.code).toBe(perAccount.sent[0]!.code);
    expect(perIp.sent[0]!.message).toBe(perAccount.sent[0]!.message);
  });

  it("still maps ThrottlerException's raw library message to a user-safe one", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { host, sent } = makeHost({ method: "POST", url: "/v1/auth/sign-in" });
    new GlobalExceptionFilter().catch(new ThrottlerException(), host);
    expect(sent[0]!.message).toBe("You're doing that too much. Please wait a bit and try again.");
    expect(String(sent[0]!.message)).not.toContain("ThrottlerException");
  });
});
