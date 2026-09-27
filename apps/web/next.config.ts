import type { NextConfig } from "next";

// Privacy: opt this project out of Next.js telemetry for every `next dev` / `next build`,
// on every OS. Next reads this env var only after next.config is evaluated, so setting it
// here is honoured. (`next telemetry status` does not read this file and may still say "Enabled".)
process.env.NEXT_TELEMETRY_DISABLED = "1";

const nextConfig: NextConfig = {
  // Hide the on-screen Next.js dev indicator (the bottom-left bubble shown
  // during `next dev`). Compile/runtime errors are still surfaced.
  devIndicators: false,
  allowedDevOrigins: ["*"],
  // The builder renders live project state; never let a proxy cache a page.
  async headers() {
    // Only cache-control headers here. CSP and CORS are handled exclusively in proxy.ts
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-cache, no-store, must-revalidate',
          },
          { key: "Pragma", value: "no-cache" },
          { key: "Expires", value: "0" },
        ],
      },
    ];
  },
};

export default nextConfig;
