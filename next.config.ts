import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Syncs wrangler bindings (D1, assets, env) into `next dev` so the panel
// behaves locally exactly like it does on Workers.
initOpenNextCloudflareForDev();

const nextConfig: NextConfig = {
  // @opennextjs/cloudflare consumes Next's standalone output (.next/standalone).
  output: "standalone",
  images: {
    // Workers have no sharp/ImageMagick; the panel serves static assets anyway.
    unoptimized: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
