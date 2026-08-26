import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@veynlo/core", "@veynlo/design-tokens"],
};

export default nextConfig;
