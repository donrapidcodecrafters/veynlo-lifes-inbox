import type { NextConfig } from "next";

// Content-Security-Policy is set per-request in src/middleware.ts instead of here — it needs a fresh
// nonce on every request so Next's own inline RSC-hydration scripts can be allowlisted without a blanket
// 'unsafe-inline' (confirmed necessary by actually driving a headless browser against a static, nonce-less
// CSP here first: it silently blocked those scripts and broke the app). Everything else that doesn't need
// per-request freshness stays a static header.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@veynlo/core", "@veynlo/design-tokens"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
