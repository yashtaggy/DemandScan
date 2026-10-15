import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * cacheComponents is disabled to allow route segment config (runtime, dynamic)
   * on API routes. These are required for Node.js server-side Kite Connect integration.
   *
   * turbopack is used for Tailwind CSS v4 in development.
   */
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
