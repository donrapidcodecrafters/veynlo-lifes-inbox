import type { NextConfig } from "next";

// Content-Security-Policy is set per-request in src/middleware.ts instead of here — see that file's
// comment for why a static, nonce-less CSP was confirmed (via headless browser) to break the app.
// The admin console is never embedded/cross-site (see identity.controller.ts's sameSite: "strict" note
// on the admin session cookie) — same posture applies to these static headers.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@veynlo/design-tokens"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
