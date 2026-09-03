import { ForbiddenException } from "@nestjs/common";

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * §28.7 "If web authentication uses cookies... every state-changing cookie-authenticated route has CSRF
 * protection" — a real, previously-open gap: the session cookie is `SameSite=Lax`, which still allows a
 * cross-site `<form>` submission (a full top-level navigation, not a fetch/XHR) to carry it on a
 * state-changing request. `SameSite=Strict` isn't a safe fix here — it would break the very OAuth
 * connector-connect flow fixed earlier this session, since Google/Microsoft's redirect back to the API is
 * itself a cross-site top-level navigation that needs the cookie present.
 *
 * Mitigation: require a custom header on every state-changing, cookie-authenticated request. A plain HTML
 * `<form>` cannot set an arbitrary header — only same-origin JavaScript (`fetch`/`XHR`) can — so its
 * presence is exactly the signal a real Veynlo client (web/admin/mobile-web-preview) can produce and a
 * cross-site form cannot forge. Bearer-token requests (native mobile) are never subject to this check at
 * all — a browser can't be tricked into attaching an `Authorization` header cross-site, so CSRF doesn't
 * apply to that transport.
 */
export function assertCsrfSafe(request: { method: string; headers: Record<string, unknown>; cookies?: Record<string, unknown> }, cookieName: string): void {
  const isCookieAuthenticated = Boolean(request.cookies?.[cookieName]);
  if (!isCookieAuthenticated) return; // bearer-token request — not a CSRF-relevant transport
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) return;
  if (request.headers["x-veynlo-csrf"]) return;
  throw new ForbiddenException({
    code: "CSRF_CHECK_FAILED",
    message: "Missing required header for this request.",
  });
}
