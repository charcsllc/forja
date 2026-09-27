import path from "node:path";
import type { NextConfig } from "next";

// No telemetry: opt out of Next.js telemetry for every `next dev` / `next build`. Next reads
// this variable after evaluating the config, so setting it here is honoured on every OS.
process.env.NEXT_TELEMETRY_DISABLED = "1";

// This file runs before `src/env.ts` can be used, so it is the one place outside `src/env.ts`
// (and `scripts/`) that reads `process.env` directly.
const isDev = process.env.NODE_ENV !== "production";

function list(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/**
 * Who may frame this app. In development the builder's origin (it shows the app in an
 * iframe); in production `'self'` unless the operator says otherwise.
 * ⚠️ `headers()` is evaluated when the dev server starts and at `next build` for production:
 * with `output: "standalone"` the production value is the one present at build time.
 */
const frameAncestors = list(process.env.ALLOWED_FRAME_ANCESTORS);

const csp = [
  "default-src 'self'",
  // Next.js inlines bootstrap scripts; webpack HMR needs eval in development only.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "media-src 'self' blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  `frame-ancestors ${frameAncestors.length > 0 ? frameAncestors.join(" ") : "'self'"}`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Framing is governed by CSP `frame-ancestors`; never add X-Frame-Options (it would
  // block the builder's preview in development).
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const devHosts = [
  process.env.NEXT_PUBLIC_APP_URL,
  process.env.INTERNAL_APP_URL,
  ...list(process.env.EXTRA_TRUSTED_ORIGINS),
]
  .map((value) => (value ? hostOf(value) : null))
  .filter((value): value is string => Boolean(value));

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  // AGENTS.md is maintained by hand (it already points agents at node_modules/next/dist/docs);
  // stop `next dev` from rewriting it, so dev runs never dirty the working tree.
  agentRules: false,
  // Node-only drivers stay out of the bundle (pg-boss uses `pg`, which has optional natives).
  serverExternalPackages: ["pg-boss", "pg"],
  allowedDevOrigins: devHosts,
  // Production builds use Turbopack; this empty block acknowledges that the `webpack` hook
  // below is development-only (Next 16 refuses a Turbopack build with an unacknowledged one).
  turbopack: { root: process.cwd() },
  // This project is its own root, even when it sits inside another repository.
  outputFileTracingRoot: process.cwd(),
  // Runtime file access (lib/storage.ts) is dynamic; never let the tracer copy sources.
  outputFileTracingExcludes: { "*": ["./src/**/*"] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // ⭐ Visual editor hook: in development every JSX element under src/ gets
  // data-tlm-loc="file:line:col" (scripts/source-tags.js). Keep this block and its first line
  // exactly as they are; the builder recognises this shape. Disable with SOURCE_TAGS=0.
  webpack: (config, { dev }) => {
    if (dev && process.env.SOURCE_TAGS !== "0") {
      config.module.rules.push({
        test: /\.(tsx|jsx)$/,
        include: path.join(process.cwd(), "src"),
        exclude: /node_modules/,
        enforce: "pre",
        use: [{ loader: path.join(process.cwd(), "scripts", "source-tags.js") }],
      });
    }
    return config;
  },
};

export default nextConfig;
