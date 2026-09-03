import { NextResponse, type NextRequest } from "next/server";

// Read at request time in middleware (edge runtime), same origin the app's own api-client.ts reads client-side.
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Nonce-based CSP (App Router's own documented pattern) rather than a static header in next.config.ts —
 * confirmed by driving a real headless browser against this app that a static `script-src 'self'` with
 * no nonce/'unsafe-inline' blocks Next's own inline RSC-hydration scripts outright, breaking the app.
 * Setting `x-nonce` on the request lets Next automatically apply the same nonce to those inline scripts.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // Next's dev-mode HMR/webpack runtime evaluates chunks via eval — confirmed via a real headless-browser
  // CSP-violation check that this is dev-only; production's build output doesn't use eval, so this stays
  // out of the production CSP rather than weakening it for a dev-only need.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    "style-src 'self' 'unsafe-inline'", // Tailwind's runtime-injected styles need this; no inline scripts are ever used
    "img-src 'self' data: blob:",
    `connect-src 'self' ${apiUrl}`,
    // Plaid Link (Phase 2 §52.2 financial aggregator — connections/page.tsx's PlaidConnectCard) opens as a
    // cross-origin iframe, not just a dynamically-injected script — 'strict-dynamic' above already covers
    // loading Plaid's own <script> tag, but frame embedding is governed separately and falls back to
    // default-src 'self' (blocking it outright) without this. The iframe manages its own network calls
    // inside its own document/CSP context, so this page's connect-src doesn't also need Plaid's API hosts.
    "frame-src 'self' https://cdn.plaid.com",
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
  matcher: [
    // Every route except static assets/images, which don't execute script and don't need a per-request nonce.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
