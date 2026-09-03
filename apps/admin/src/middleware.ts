import { NextResponse, type NextRequest } from "next/server";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Nonce-based CSP (App Router's own documented pattern) rather than a static header — confirmed by
 * driving a real headless browser against apps/web with this exact approach first that a static
 * `script-src 'self'` with no nonce/'unsafe-inline' blocks Next's own inline RSC-hydration scripts
 * outright, breaking the app. Setting `x-nonce` on the request lets Next automatically apply the same
 * nonce to those inline scripts.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // Next's dev-mode HMR/webpack runtime evaluates chunks via eval — confirmed dev-only via a real
  // headless-browser CSP-violation check against apps/web; production's build output doesn't need it.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    "style-src 'self' 'unsafe-inline'", // Tailwind's runtime-injected styles need this; no inline scripts are ever used
    "img-src 'self' data: blob:",
    `connect-src 'self' ${apiUrl}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
