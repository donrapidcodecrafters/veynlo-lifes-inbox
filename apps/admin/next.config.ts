import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@veynlo/design-tokens"],
};

export default nextConfig;
