import type { NextConfig } from "next";
import path from "node:path";

// Privacy: opt this project out of Next.js telemetry for every `next dev` / `next build`,
// on every OS. Next reads this env var only after next.config is evaluated, so setting it
// here is honoured. (`next telemetry status` does not read this file and may still say "Enabled".)
process.env.NEXT_TELEMETRY_DISABLED = "1";

const nextConfig: NextConfig = {
  // Self-contained server for the container image (`.next/standalone/apps/web/server.js`).
  output: "standalone",
  // npm-workspaces monorepo: trace from the repo root so hoisted `node_modules` and the
  // workspace packages end up in the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Shared wire types with the engine, published as TypeScript source.
  transpilePackages: ["@forja/contracts"],
  // Hide the on-screen Next.js dev indicator (the bottom-left bubble shown
  // during `next dev`). Compile/runtime errors are still surfaced.
  devIndicators: false,
  allowedDevOrigins: ["*"],
  // The builder renders live project state; never let a proxy cache a page.
  async headers() {
    // Only cache-control headers here. CSP and CORS are handled exclusively in proxy.ts
    return [
      {
        // Everything except `/api/files/*`, whose cache headers come from the engine's
        // signed file (a 30-day upload can be cached; forja, 05 §2.3).
        source: '/((?!api/files/).*)',
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
